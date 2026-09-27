// h4 child: wait until T0 (epoch ms, argv[2]), then generate N ObjectIds (argv[3], default 300), print JSON array.
import { ObjectId } from "bson";

const t0 = Number(process.argv[2] ?? 0);
const n = Number(process.argv[3] ?? 300);
const delay = Math.max(0, t0 - Date.now());
await new Promise((r) => setTimeout(r, delay));
const out: string[] = [];
const start = Date.now();
for (let i = 0; i < n; i++) out.push(new ObjectId().toHexString());
process.stdout.write(JSON.stringify({ ids: out, startMs: start }) + "\n");
