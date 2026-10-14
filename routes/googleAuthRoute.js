import express from "express";
import { googleNativeCallback } from "../controllers/googleNativeController.js";

const router = express.Router();

router.post("/native", googleNativeCallback);

export default router;
