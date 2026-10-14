import { google } from "googleapis";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";

// Native Google sign-in (Google One Tap on-device). The mobile app obtains a
// Google ID token via the native SDK and POSTs it here as { idToken }.
// The token is verified against GOOGLE_CLIENT_ID — profile data from the
// client is never trusted. There is no link/redirect OAuth flow.
export const googleNativeCallback = async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ success: false, error: "google_auth_failed" });
    }

    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID);
    const ticket = await oauth2Client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.status(401).json({ success: false, error: "google_auth_failed" });
    }

    const { email, name, email_verified } = payload;

    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          username: name || email.split("@")[0],
          email,
          isVerified: email_verified ?? true,
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
          isVerified: !user.isVerified && email_verified ? true : user.isVerified,
        },
      });
    }

    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.session.create({ data: { userId: user.id } });

    const accessToken = jwt.sign({ id: user.id }, process.env.SECRET_KEY, { expiresIn: "10d" });
    const refreshToken = jwt.sign({ id: user.id }, process.env.SECRET_KEY, { expiresIn: "30d" });

    await prisma.user.update({ where: { id: user.id }, data: { isLoggedIn: true } });

    return res.status(200).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        termsAccepted: user.termsAccepted,
        isVerified: user.isVerified,
        authProvider: user.authProvider,
      },
    });
  } catch (error) {
    return res.status(401).json({ success: false, error: "google_auth_failed" });
  }
};
