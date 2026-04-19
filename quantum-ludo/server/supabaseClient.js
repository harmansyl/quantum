import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// Support both REACT_APP_* (client) and SUPABASE_* (server) env var names
const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;

let supabase = null;
if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_KEY not set — running in in-memory fallback mode");
  // Export null; server code wraps Supabase calls in try/catch and will fall back to memory
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("✅ Supabase client initialized with URL:", supabaseUrl);
}

export default supabase;
