import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === "function" ? "[fn]" : v,
    );
  } catch (err) {
    return `[unserializable: ${String(err)}]`;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    req.log.warn(
      {
        authDebug: {
          hasCookieHeader: Boolean(req.headers.cookie),
          hasSessionCookie: Boolean(req.headers.cookie?.includes("__session")),
          authorizationHeader: req.headers.authorization ? "present" : "absent",
          origin: req.headers.origin ?? null,
          host: req.headers.host ?? null,
          xForwardedHost: req.headers["x-forwarded-host"] ?? null,
          clerkUserId: auth?.userId ?? null,
          clerkSessionId: auth?.sessionId ?? null,
          fullAuth: safeStringify(auth),
        },
      },
      "requireAuth: unauthorized request (temporary diagnostic)",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}
