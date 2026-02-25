import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import supabase from "../supabaseClient.js";

const router = express.Router();

// ✅ REGISTER
router.post("/register", async (req, res) => {
  try {
    const { username, phone, password } = req.body;

    if (!username || !phone || !password) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const phoneStr = String(phone);
    
    // Check if phone already exists
    const { data: existingUser, error: fetchError } = await supabase
      .from("users")
      .select("id")
      .eq("phone", phoneStr)
      .single();

    if (existingUser) {
      return res.status(400).json({ message: "Phone already registered." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create new user
    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert([
        {
          username,
          phone: phoneStr,
          password_hash: passwordHash,
          total_matches: 0,
          wins: 0,
          losses: 0,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error("❌ Registration error:", insertError);
      return res.status(500).json({ message: "Server error during registration." });
    }

    const token = jwt.sign(
      { id: newUser.id, phone: newUser.phone },
      process.env.JWT_SECRET || "defaultsecret",
      { expiresIn: "1d" }
    );

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        phone: newUser.phone,
        createdAt: newUser.created_at,
      },
    });
  } catch (err) {
    console.error("❌ Registration error:", err);
    res.status(500).json({ message: "Server error during registration." });
  }
});

// ✅ LOGIN
router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ message: "Phone and password required." });
    }

    const phoneStr = String(phone);
    
    // Find user by phone
    const { data: user, error: fetchError } = await supabase
      .from("users")
      .select("*")
      .eq("phone", phoneStr)
      .single();

    if (fetchError || !user) {
      return res.status(400).json({ message: "User not found." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password." });
    }

    const token = jwt.sign(
      { id: user.id, phone: user.phone },
      process.env.JWT_SECRET || "defaultsecret",
      { expiresIn: "1d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ message: "Server error during login." });
  }
});

// ✅ FETCH USER DATA (for Profile page)
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided." });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || "defaultsecret");
    } catch (e) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    // If Supabase is not configured, return minimal user info from the token
    if (!supabase) {
      const user = { id: decoded.id, phone: decoded.phone };
      return res.json({ user });
    }

    const { data: user, error: fetchError } = await supabase
      .from("users")
      .select("id, username, phone, total_matches, wins, losses, created_at")
      .eq("id", decoded.id)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user });
  } catch (err) {
    console.error("❌ Error fetching user data:", err);
    res.status(500).json({ message: "Error fetching user data." });
  }
});

export default router;
