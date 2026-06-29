import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";

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
          // @ts-expect-error reason is present on Clerk auth object for failures
          clerkReason: auth?.reason ?? null,
          // @ts-expect-error tokenType is present on newer Clerk auth objects
          clerkTokenType: auth?.tokenType ?? null,
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
