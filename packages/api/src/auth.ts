import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { pool } from "./db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export interface AuthUser {
  id: string;
  email: string;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    (req as any).user = { id: decoded.userId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
  const result = await pool.query(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [email]
  );
  if (result.rows.length === 0) return null;
  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
  return { token, user: { id: user.id, email: user.email } };
}

// Password validation
function validatePassword(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters long" };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password must be less than 128 characters" };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: "Password must contain at least one lowercase letter" };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: "Password must contain at least one uppercase letter" };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: "Password must contain at least one number" };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, error: "Password must contain at least one special character" };
  }
  return { valid: true };
}

// Email validation
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

export async function register(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  // Validate email
  if (!validateEmail(email)) {
    throw new Error("Invalid email address");
  }
  
  // Validate password
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }
  
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
    [email.toLowerCase().trim(), hash]
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
  return { token, user: { id: user.id, email: user.email } };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  // Validate new password
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }
  
  // Get current password hash
  const result = await pool.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId]
  );
  if (result.rows.length === 0) {
    throw new Error("User not found");
  }
  
  // Verify current password
  const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!valid) {
    throw new Error("Current password is incorrect");
  }
  
  // Update password
  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query(
    "UPDATE users SET password_hash = $1 WHERE id = $2",
    [newHash, userId]
  );
}

export async function deleteUser(userId: string, password: string): Promise<void> {
  // Verify password before deletion
  const result = await pool.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId]
  );
  if (result.rows.length === 0) {
    throw new Error("User not found");
  }
  
  const valid = await bcrypt.compare(password, result.rows[0].password_hash);
  if (!valid) {
    throw new Error("Password is incorrect");
  }
  
  // Delete user (cascade will handle channels and streams)
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
}
