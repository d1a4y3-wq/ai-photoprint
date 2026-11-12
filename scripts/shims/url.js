export const fileURLToPath = (u) => decodeURIComponent((typeof u === "string" ? new URL(u) : u).pathname);
