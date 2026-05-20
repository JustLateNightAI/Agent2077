/**
 * Authentication Middleware — JWT-based session auth
 */
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { userStore } from "../storage.js";

// In production, this should be in an env var. For local-only use this is fine.
const JWT_SECRET = process.env.JWT_SECRET || "agent2077-local-secret-key-change-in-production";
const TOKEN_EXPIRY = "7d";

export interface AuthRequest extends Request {
  userId?: number;
  username?: string;
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verify a JWT token
 */
export function verifyToken(token: string): { userId: number; username: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: number; username: string };
  } catch {
    return null;
  }
}

/**
 * Auth middleware — protects API routes
 * Checks Authorization header (Bearer token) or cookie
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Check cookie fallback
  if (!token) {
    token = req.cookies?.agent2077_token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Verify user still exists
  const user = userStore.getById(payload.userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  req.userId = payload.userId;
  req.username = payload.username;
  next();
}

/**
 * Login handler
 */
export function handleLogin(req: Request, res: Response) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const user = userStore.getByUsername(username);
  if (!user || !userStore.verifyPassword(user, password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = generateToken(user.id, user.username);

  // Set cookie — secure flag depends on whether HTTPS is enabled
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.TLS_ENABLED === "true";
  res.cookie("agent2077_token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: isSecure,
  });

  res.json({ token, username: user.username, userId: user.id });
}

/**
 * Change password handler
 */
export function handleChangePassword(req: AuthRequest, res: Response) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password required" });
  }

  const user = userStore.getById(req.userId!);
  if (!user || !userStore.verifyPassword(user, currentPassword)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  userStore.updatePassword(user.id, newPassword);
  res.json({ success: true });
}

/**
 * Change username handler
 */
export function handleChangeUsername(req: AuthRequest, res: Response) {
  const { newUsername } = req.body;
  if (!newUsername) {
    return res.status(400).json({ error: "New username required" });
  }

  const existing = userStore.getByUsername(newUsername);
  if (existing && existing.id !== req.userId) {
    return res.status(409).json({ error: "Username already taken" });
  }

  userStore.updateUsername(req.userId!, newUsername);

  // Issue new token with updated username
  const token = generateToken(req.userId!, newUsername);
  const isSecureCtx = req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.TLS_ENABLED === "true";
  res.cookie("agent2077_token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: isSecureCtx,
  });

  res.json({ success: true, username: newUsername, token });
}
