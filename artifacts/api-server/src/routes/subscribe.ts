import { Router, type IRouter } from "express";

const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/subscribe", async (req, res): Promise<void> => {
  const email =
    typeof req.body?.email === "string" ? req.body.email.trim() : "";

  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ status: "invalid_email" });
    return;
  }

  const apiKey = process.env["MAILCHIMP_API_KEY"];
  const audienceId = process.env["MAILCHIMP_AUDIENCE_ID"];

  if (!apiKey || !audienceId) {
    req.log.error("Mailchimp credentials are not configured");
    res.status(500).json({ status: "error" });
    return;
  }

  const dashIndex = apiKey.lastIndexOf("-");
  const dc = dashIndex >= 0 ? apiKey.slice(dashIndex + 1) : "";
  if (!dc) {
    req.log.error("Malformed Mailchimp API key: missing datacenter suffix");
    res.status(500).json({ status: "error" });
    return;
  }

  const url = `https://${dc}.api.mailchimp.com/3.0/lists/${audienceId}/members`;
  const auth = Buffer.from(`anystring:${apiKey}`).toString("base64");

  try {
    const mcRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        status: "subscribed",
      }),
    });

    if (mcRes.ok) {
      res.json({ status: "subscribed" });
      return;
    }

    const body = (await mcRes.json().catch(() => ({}))) as {
      title?: string;
      detail?: string;
    };

    if (mcRes.status === 400 && body.title === "Member Exists") {
      res.json({ status: "already" });
      return;
    }

    req.log.error(
      { status: mcRes.status, title: body.title, detail: body.detail },
      "Mailchimp subscribe failed",
    );
    res.status(502).json({ status: "error" });
  } catch (err) {
    req.log.error({ err }, "Mailchimp request threw");
    res.status(502).json({ status: "error" });
  }
});

export default router;
