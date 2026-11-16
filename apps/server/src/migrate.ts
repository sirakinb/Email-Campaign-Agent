import { migrate, sql } from './db.js';

const applied = await migrate();
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await sql.end();
