// Avalor — Supabase client
// These credentials are safe to use in frontend code (publishable key)

const SUPABASE_URL = 'https://jjegxgveeowrrgnfvaxn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_WWzB1IuUp8jYWZ10Mf2-xA_R_4ai4xI';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
