import nodemailer from "nodemailer";

// Email configuration - uses environment variables
// For production, set these in Railway:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // true for 465, false for other ports
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

// Check if email is configured
const isEmailConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

export async function sendWelcomeEmail(email: string): Promise<void> {
  if (!isEmailConfigured) {
    console.log(`📧 [Email not configured] Would send welcome email to ${email}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Welcome to LAF MVP!",
      html: `
        <h1>Welcome to LAF MVP!</h1>
        <p>Thank you for creating an account. You can now start broadcasting your music!</p>
        <p>If you have any questions, feel free to reach out.</p>
        <p>Happy streaming!</p>
      `,
      text: "Welcome to LAF MVP! Thank you for creating an account. You can now start broadcasting your music!",
    });
    console.log(`✅ Welcome email sent to ${email}`);
  } catch (error) {
    console.error(`❌ Failed to send welcome email to ${email}:`, error);
    // Don't throw - email failures shouldn't break registration
  }
}

export async function sendPasswordChangedEmail(email: string): Promise<void> {
  if (!isEmailConfigured) {
    console.log(`📧 [Email not configured] Would send password changed email to ${email}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Your password has been changed",
      html: `
        <h1>Password Changed</h1>
        <p>Your password has been successfully changed.</p>
        <p>If you didn't make this change, please contact support immediately.</p>
      `,
      text: "Your password has been successfully changed. If you didn't make this change, please contact support immediately.",
    });
    console.log(`✅ Password changed email sent to ${email}`);
  } catch (error) {
    console.error(`❌ Failed to send password changed email to ${email}:`, error);
  }
}

export async function sendAccountDeletedEmail(email: string): Promise<void> {
  if (!isEmailConfigured) {
    console.log(`📧 [Email not configured] Would send account deleted email to ${email}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Your account has been deleted",
      html: `
        <h1>Account Deleted</h1>
        <p>Your account has been permanently deleted.</p>
        <p>We're sorry to see you go. If this was a mistake, please contact support.</p>
      `,
      text: "Your account has been permanently deleted. We're sorry to see you go. If this was a mistake, please contact support.",
    });
    console.log(`✅ Account deleted email sent to ${email}`);
  } catch (error) {
    console.error(`❌ Failed to send account deleted email to ${email}:`, error);
  }
}
