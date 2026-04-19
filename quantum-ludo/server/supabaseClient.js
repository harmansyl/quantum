import { createClient } from '@supabase/supabase-client';
import dotenv from 'dotenv';
dotenv.config();

// This checks every possible name we might have used
const supabaseUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: Supabase URL or Key is missing from Environment Variables!");
}

export const supabase = createClient(supabaseUrl, supabaseKey);