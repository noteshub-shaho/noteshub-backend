import { BrevoClient } from "@getbrevo/brevo";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import handlebars from "handlebars";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.BREVO_API_KEY) {
  throw new Error("BREVO_API_KEY is not set in environment variables");
}

const brevo = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY,
  timeoutInSeconds: 30,
  maxRetries: 2,
});

export const verifyMail = async (token, email) => {
  try {
    const cleanEmail = String(email).trim();
    if (!cleanEmail) {
      throw new Error("Recipient email missing");
    }

   const verifyLink = `${process.env.BACKEND_URL}/api/auth/verify/${token}`;

    const source = fs.readFileSync(
      path.join(__dirname, "template.hbs"),
      "utf-8"
    );

    const template = handlebars.compile(source);

    const htmlContent = template({
      verifyLink,
      year: new Date().getFullYear(),
    });

    await brevo.transactionalEmails.sendTransacEmail({
      sender: {
        name: "NotesHub",
        email: process.env.NOTESHUB_SENDER_EMAIL,
      },
      to: [{ email: cleanEmail }],
      subject: "Verify Your Email - NotesHub",
      htmlContent,
    });

    console.log("Verification email sent successfully to:", cleanEmail);
  } catch (err) {
    const status = err?.statusCode ?? err?.status;
    if (status === 401) {
      console.error("Brevo: Invalid API key");
      throw new Error("Email service authentication failed");
    }
    if (status === 429) {
      console.error("Brevo: Rate limit hit");
      throw new Error("Email service rate limit exceeded, try again later");
    }
    if (status) {
      console.error("Brevo API error:", err.message);
      throw new Error("Email service error, please try again");
    }
    console.error("Verification email failed:", err.message);
    throw err;
  }
};