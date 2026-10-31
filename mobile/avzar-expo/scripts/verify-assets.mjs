import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8')).expo;
const paths = [config.icon, config.android?.adaptiveIcon?.foregroundImage, config.web?.favicon, config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')?.[1]?.image];
const missing = paths.filter((path) => typeof path !== 'string' || !path.startsWith('./assets/') || !isPng(resolve(root, path)));
if (missing.length) {
  console.error(`Missing or invalid Expo assets: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${paths.length} Expo asset references from app.json.`);
}

function isPng(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 24) return false;
    return readFileSync(path).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } catch {
    return false;
  }
}
