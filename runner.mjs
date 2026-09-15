import { spawn } from 'node:child_process';

const SLEEP_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runMinter() {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['mint-bot.mjs'], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        durationMs: Date.now() - started,
      });
    });
  });
}

console.log('Rare Friends cloud runner started. It will stay online until the mint window.');

while (true) {
  const result = await runMinter();

  // Before the bot is inside its 45-minute arm window it exits quickly.
  // Keep the cloud service alive and re-check every five minutes.
  if (result.durationMs < 60_000) {
    console.log(`Minter pass finished in ${Math.round(result.durationMs / 1000)}s; checking again in 5 minutes.`);
    await sleep(SLEEP_MS);
    continue;
  }

  // If a pass stayed alive for more than a minute, it entered the armed wait path.
  // After that pass completes, leave the worker running but do not immediately hammer RPC.
  console.log('Armed mint pass completed. Re-checking state in five minutes.');
  await sleep(SLEEP_MS);
}
