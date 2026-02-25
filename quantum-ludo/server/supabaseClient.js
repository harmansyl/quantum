import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_KEY not set — running in in-memory fallback mode");
  // Export null; server code wraps Supabase calls in try/catch and will fall back to memory
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
}

export default supabase;
