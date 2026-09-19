import prisma from "../lib/prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { verifyMail } from "../emailVerify/verifyMail.js";
import { sendOtpMail } from "../emailVerify/sendOtpMail.js";
import { BrevoClient } from "@getbrevo/brevo";

const FRONTEND_URL = process.env.FRONTEND_URL;

export const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser && existingUser.isVerified) {
      return res.status(400).json({
        success: false,
        message: "User already exists. Please login.",
      });
    }

    if (existingUser && !existingUser.isVerified) {
      const token = jwt.sign(
        { id: existingUser.id },
        process.env.SECRET_KEY,
        { expiresIn: "10m" }
      );

      await prisma.user.update({
        where: { id: existingUser.id },
        data: { token },
      });

      await verifyMail(token, email);

      return res.status(200).json({
        success: true,
        message: "Verification email resent.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        username: name,
        email,
        password: hashedPassword,
        isVerified: false,
        isLoggedIn: false,
        termsAccepted: false,
        authProvider: "local",
      },
    });

    const token = jwt.sign(
      { id: user.id },
      process.env.SECRET_KEY,
      { expiresIn: "10m" }
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { token },
    });

    await verifyMail(token, email);

    return res.status(201).json({
      success: true,
      message: "Registered successfully. Verify your email.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const verification = async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.redirect(`${FRONTEND_URL}?verified=false`);
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.SECRET_KEY);
    } catch (err) {
      return res.redirect(
        err.name === "TokenExpiredError"
          ? `${FRONTEND_URL}?verified=expired`
          : `${FRONTEND_URL}?verified=false`
      );
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user) {
      return res.redirect(`${FRONTEND_URL}?verified=false`);
    }

    if (user.isVerified) {
      return res.redirect(`${FRONTEND_URL}?verified=true`);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true, token: null },
    });

    return res.redirect(`${FRONTEND_URL}?verified=true`);
  } catch (error) {
    return res.redirect(`${FRONTEND_URL}?verified=false`);
  }
};

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (user.authProvider === "google" || !user.password) {
      return res.status(401).json({
        success: false,
        message: "This account uses Google sign-in. Please continue with Google.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email",
      });
    }

    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.session.create({ data: { userId: user.id } });

    const accessToken = jwt.sign(
      { id: user.id },
      process.env.SECRET_KEY,
      { expiresIn: "10d" }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.SECRET_KEY,
      { expiresIn: "30d" }
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { isLoggedIn: true },
    });

    return res.status(200).json({
      success: true,
      message: `Welcome ${user.username}`,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        termsAccepted: user.termsAccepted,
      },
    });
  } catch (error) {
      console.error("LOGIN ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const logoutUser = async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.update({
      where: { id: userId },
      data: { isLoggedIn: false },
    });

    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { otp, otpExpiry: expiry },
    });

    await sendOtpMail(email, otp);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const verifyOTP = async (req, res) => {
  try {
    const { otp } = req.body;
    const { email } = req.params;

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    if (user.otpExpiry < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP expired",
      });
    }

    if (otp !== user.otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { otp: null, otpExpiry: null },
    });

    return res.status(200).json({
      success: true,
      message: "OTP verified",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { email } = req.params;
    const { newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match",
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword, isLoggedIn: false },
    });

    await prisma.session.deleteMany({ where: { userId: user.id } });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};


export const sendContactMail = async (req, res) => {
  try {
    const { fullName, email, message } = req.body;

    if (!fullName || !email || !message) {
      return res.status(400).json({
        success: false,
        message: "All fields required",
      });
    }

    const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });

    await brevo.transactionalEmails.sendTransacEmail({
      sender: {
        name: "NotesHub",
        email: process.env.NOTESHUB_SENDER_EMAIL,
      },
      to: [{ email: process.env.NOTESHUB_SENDER_EMAIL }],
      replyTo: { email, name: fullName },
      subject: `New Contact Message from ${fullName}`,
      htmlContent: `
        <h2>New Contact Message</h2>
        <p><b>Name:</b> ${fullName}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Message:</b> ${message}</p>
      `,
    });

    return res.status(200).json({
      success: true,
      message: "Mail sent successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Mail sending failed",
    });
  }
};