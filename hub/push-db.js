require('dotenv').config({ path: '.env.local' });
const { execSync } = require('child_process');

try {
  const output = execSync('npx drizzle-kit generate', { encoding: 'utf-8' });
  console.log(output);
} catch (e) {
  console.error(e.stdout);
  console.error(e.stderr);
  process.exit(1);
}
