import { google } from "googleapis";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

export const getGoogleAuthUrl = (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
  });
  return res.status(200).json({ success: true, url });
};

export const googleCallback = async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL;

  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, error: "google_auth_failed" });
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: googleUser } = await oauth2.userinfo.get();

    const { email, name, verified_email } = googleUser;

    if (!email) {
      return res.redirect(`${FRONTEND_URL}/login?error=no_email`);
    }

    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          username: name || email.split("@")[0],
          email,
          isVerified: verified_email ?? true,
          isLoggedIn: false,
          termsAccepted: false,
          authProvider: "google",
        },
      });
    } else if (user.authProvider === "local") {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          authProvider: "google",
          isVerified: !user.isVerified && verified_email ? true : user.isVerified,
        },
      });
    }

    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.session.create({ data: { userId: user.id } });

    const accessToken = jwt.sign(
      { id: user.id },
      process.env.SECRET_KEY,
      { expiresIn: "10d" }
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { isLoggedIn: true },
    });

    const userData = {
      id: user.id,
      username: user.username,
      email: user.email,
      termsAccepted: user.termsAccepted,
    };

    const encodedUser = Buffer.from(JSON.stringify(userData)).toString("base64url");

    return res.status(200).json({
      success: true,
      token: accessToken,
      user: userData,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "google_auth_failed" });
  }
};