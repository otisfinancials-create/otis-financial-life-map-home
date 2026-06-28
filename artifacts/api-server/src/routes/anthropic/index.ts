import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, conversations, messages } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendAnthropicMessageBody } from "@workspace/api-zod";

const router: IRouter = Router();

const USER_ID = 1;

function buildSystemPrompt(financialContext: string): string {
  return `You are Otis, a personal financial intelligence assistant for high-earning households. You are direct, precise, and data-driven — think Bloomberg terminal meets a trusted CFP.

You have access to the user's live financial data:

${financialContext}

Guidelines:
- Answer questions about their finances using the data above.
- Be concise and specific. Use exact numbers from their data.
- Format dollar amounts clearly (e.g. $12,500/mo).
- When discussing cash flow, reference their actual bills and pay schedules.
- If asked about projections or forecasts, reason from their real income and expenses.
- Never make up numbers not present in the context.
- Do not use emojis.`;
}

async function getFinancialContext(): Promise<string> {
  const { accountsTable, billsTable, paySchedulesTable } = await import("@workspace/db");
  const { eq: eqOp } = await import("drizzle-orm");

  const [accounts, bills, paySchedules] = await Promise.all([
    db.select().from(accountsTable),
    db.select().from(billsTable).where(eqOp(billsTable.isActive, true)),
    db.select().from(paySchedulesTable),
  ]);

  const FREQ_TO_MONTHLY: Record<string, number> = {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    "bi-weekly": 26 / 12,
    monthly: 1,
    quarterly: 1 / 3,
    annually: 1 / 12,
    yearly: 1 / 12,
  };

  const totalAssets = accounts
    .filter((a) => a.isAsset)
    .reduce((s, a) => s + parseFloat(String(a.currentBalance)), 0);
  const totalLiabilities = accounts
    .filter((a) => !a.isAsset)
    .reduce((s, a) => s + parseFloat(String(a.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  const monthlyIncome = paySchedules.reduce((s, p) => {
    const mult = FREQ_TO_MONTHLY[p.frequency] ?? 1;
    return s + parseFloat(String(p.amount)) * mult;
  }, 0);

  const monthlyExpenses = bills.reduce((s, b) => {
    const mult = FREQ_TO_MONTHLY[b.frequency] ?? 1;
    return s + parseFloat(String(b.amount)) * mult;
  }, 0);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  const accountLines = accounts
    .map((a) => `  - ${a.accountName} (${a.accountType}): ${fmt(parseFloat(String(a.currentBalance)))} [${a.isAsset ? "asset" : "liability"}]`)
    .join("\n");

  const billLines = bills
    .map((b) => `  - ${b.billName} (${b.category}): ${fmt(parseFloat(String(b.amount)))} ${b.frequency}, due day ${b.dueDay}`)
    .join("\n");

  const incomeLines = paySchedules
    .map((p) => `  - ${p.employerName}: ${fmt(parseFloat(String(p.amount)))} ${p.frequency} (~${fmt(parseFloat(String(p.amount)) * (FREQ_TO_MONTHLY[p.frequency] ?? 1))}/mo)`)
    .join("\n");

  return `NET WORTH: ${fmt(netWorth)} (Assets: ${fmt(totalAssets)}, Liabilities: ${fmt(totalLiabilities)})
MONTHLY INCOME: ${fmt(monthlyIncome)}
MONTHLY EXPENSES: ${fmt(monthlyExpenses)}
MONTHLY CASH FLOW: ${fmt(monthlyIncome - monthlyExpenses)}

ACCOUNTS:
${accountLines}

ACTIVE BILLS & RECURRING EXPENSES:
${billLines}

PAY SCHEDULES (income sources):
${incomeLines}`;
}

router.get("/anthropic/conversations", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.createdAt));

  res.json(
    rows.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
    }))
  );
});

router.post("/anthropic/conversations", async (req, res): Promise<void> => {
  const { title } = req.body as { title: string };

  const [created] = await db
    .insert(conversations)
    .values({ title: title ?? "New conversation" })
    .returning();

  res.status(201).json({
    id: created.id,
    title: created.title,
    createdAt: created.createdAt.toISOString(),
  });
});

router.get("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  res.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt.toISOString(),
    messages: msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

router.delete("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).send();
});

router.get("/anthropic/conversations/:id/messages", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  res.json(
    msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }))
  );
});

router.post("/anthropic/conversations/:id/messages", async (req, res): Promise<void> => {
  const convId = parseInt(req.params.id, 10);

  const parseResult = SendAnthropicMessageBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { content } = parseResult.data;

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  await db.insert(messages).values({ conversationId: convId, role: "user", content });

  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(asc(messages.createdAt));

  const financialContext = await getFinancialContext();

  const chatMessages = allMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: buildSystemPrompt(financialContext),
    messages: chatMessages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      fullResponse += event.delta.text;
      res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
    }
  }

  await db.insert(messages).values({
    conversationId: convId,
    role: "assistant",
    content: fullResponse,
  });

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

export default router;
