import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddressEqual,
  keccak256,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { performance } from 'node:perf_hooks';

const NFT = '0x116eaa62241751e0c98da43d458600c6c17cd361';
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';
const EXPECTED_WALLET = '0x810746D67175869935c0152a55f77Aa40C6f299c';

const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const DIRECT_SEQUENCER = 'https://sequencer.mainnet.chain.robinhood.com';
const RPC_URL = process.env.RPC_URL || PUBLIC_RPC;
const EXTRA_BROADCAST_RPCS = String(process.env.EXTRA_BROADCAST_RPCS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

// Exact same raw transaction is sent to every endpoint. This is one mint/one nonce/one tx hash.
const BROADCAST_RPCS = [...new Set([
  DIRECT_SEQUENCER,
  RPC_URL,
  PUBLIC_RPC,
  ...EXTRA_BROADCAST_RPCS,
])];

const MAX_MINT_VALUE_WEI = BigInt(process.env.MAX_MINT_VALUE_WEI || '0');
const MAX_GAS_COST_WEI = BigInt(process.env.MAX_GAS_COST_WEI || '1000000000000000'); // 0.001 ETH
const ARM_WINDOW_MS = Number(process.env.ARM_WINDOW_MS || 90 * 60 * 1000);
const SEND_OFFSET_MS = Number(process.env.SEND_OFFSET_MS || 8);
const CHECK_ONLY = process.argv.includes('--check');

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Robinhood Chain Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(RPC_URL, { timeout: 8_000, retryCount: 3, retryDelay: 100 }),
});

const seaDropAbi = [
  {
    type: 'function',
    name: 'getPublicDrop',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'mintPublic',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  },
];

const nftAbi = [
  {
    type: 'function',
    name: 'getMintStats',
    stateMutability: 'view',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [
      { name: 'minterNumMinted', type: 'uint256' },
      { name: 'currentTotalSupply', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
    ],
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Uses monotonic high-resolution time for the final part of the launch wait.
async function waitUntilEpoch(targetEpochMs) {
  let remaining = targetEpochMs - Date.now();
  if (remaining <= 0) return;

  while (remaining > 50) {
    await sleep(Math.max(1, remaining - 25));
    remaining = targetEpochMs - Date.now();
  }

  const targetPerf = performance.now() + Math.max(0, targetEpochMs - Date.now());
  while (performance.now() < targetPerf) {
    // Intentional tiny busy-wait for the final ~50ms to avoid timer scheduling jitter.
  }
}

async function readState() {
  const [chainId, publicDrop, stats, balance] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: SEADROP, abi: seaDropAbi, functionName: 'getPublicDrop', args: [NFT] }),
    publicClient.readContract({ address: NFT, abi: nftAbi, functionName: 'getMintStats', args: [EXPECTED_WALLET] }),
    publicClient.getBalance({ address: EXPECTED_WALLET }),
  ]);

  const [minterNumMinted, currentTotalSupply, maxSupply] = stats;
  return { chainId, publicDrop, minterNumMinted, currentTotalSupply, maxSupply, balance };
}

function logState(state) {
  const p = state.publicDrop;
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    chainId: state.chainId,
    wallet: EXPECTED_WALLET,
    walletBalanceWei: state.balance.toString(),
    nft: NFT,
    seaDrop: SEADROP,
    minterNumMinted: state.minterNumMinted.toString(),
    currentTotalSupply: state.currentTotalSupply.toString(),
    maxSupply: state.maxSupply.toString(),
    remainingSupply: (state.maxSupply - state.currentTotalSupply).toString(),
    publicDrop: {
      mintPriceWei: p.mintPrice.toString(),
      startTime: Number(p.startTime),
      startIso: Number(p.startTime) ? new Date(Number(p.startTime) * 1000).toISOString() : null,
      endTime: Number(p.endTime),
      endIso: Number(p.endTime) ? new Date(Number(p.endTime) * 1000).toISOString() : null,
      maxTotalMintableByWallet: Number(p.maxTotalMintableByWallet),
      feeBps: Number(p.feeBps),
      restrictFeeRecipients: p.restrictFeeRecipients,
    },
    broadcastEndpoints: BROADCAST_RPCS.length,
    sendOffsetMs: SEND_OFFSET_MS,
  }, null, 2));
}

function safetyChecks(state) {
  if (state.chainId !== 4663) throw new Error(`Wrong chain: ${state.chainId}`);
  if (state.currentTotalSupply >= state.maxSupply) throw new Error('Sold out.');
  if (state.publicDrop.mintPrice > MAX_MINT_VALUE_WEI) {
    throw new Error(`Safety stop: mint price is ${state.publicDrop.mintPrice} wei; max allowed is ${MAX_MINT_VALUE_WEI}.`);
  }
  const cap = BigInt(state.publicDrop.maxTotalMintableByWallet);
  if (cap === 0n) throw new Error('Public drop is not configured (wallet cap is zero).');
  if (state.minterNumMinted >= cap) {
    throw new Error(`Wallet has already minted ${state.minterNumMinted}; public wallet cap is ${cap}.`);
  }
  if (state.publicDrop.startTime === 0n) throw new Error('Public drop start time is not configured yet.');
  if (state.publicDrop.endTime !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= state.publicDrop.endTime) {
    throw new Error('Public mint has ended.');
  }
}

async function rpcCall(url, method, params, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const latencyMs = performance.now() - started;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (body.error) {
      const error = new Error(body.error.message || JSON.stringify(body.error));
      error.rpcCode = body.error.code;
      error.latencyMs = latencyMs;
      throw error;
    }
    return { result: body.result, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

async function warmBroadcastConnections() {
  const results = await Promise.allSettled(
    BROADCAST_RPCS.map(async (url) => {
      const res = await rpcCall(url, 'eth_chainId', [], 1200);
      return { url, latencyMs: res.latencyMs, chainId: res.result };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      console.log(`WARM ${result.value.url} ${result.value.latencyMs.toFixed(1)}ms`);
    } else {
      console.log(`WARM FAILED: ${result.reason?.message || result.reason}`);
    }
  }
}

function acceptedDuplicateError(message = '') {
  return /already known|known transaction|already imported|nonce too low/i.test(message);
}

async function broadcastOne(url, serializedTransaction) {
  const started = performance.now();
  try {
    const res = await rpcCall(url, 'eth_sendRawTransaction', [serializedTransaction], 1800);
    return {
      ok: true,
      url,
      hash: res.result,
      latencyMs: performance.now() - started,
      status: 'accepted',
    };
  } catch (err) {
    const message = err?.message || String(err);
    if (acceptedDuplicateError(message)) {
      return {
        ok: true,
        url,
        hash: null,
        latencyMs: performance.now() - started,
        status: 'already-seen',
      };
    }
    return {
      ok: false,
      url,
      hash: null,
      latencyMs: performance.now() - started,
      status: message,
    };
  }
}

async function fanoutWave(serializedTransaction, wave) {
  const results = await Promise.all(BROADCAST_RPCS.map((url) => broadcastOne(url, serializedTransaction)));
  for (const r of results) {
    console.log(`BROADCAST wave=${wave} ${r.ok ? 'OK' : 'ERR'} ${r.latencyMs.toFixed(1)}ms ${r.url} ${r.status}`);
  }
  return results;
}

async function ultraFastBroadcast(serializedTransaction) {
  // Wave 1 is the real launch. Waves 2/3 resend the exact same signed tx/hash to cover transient transport failure.
  const wave1 = fanoutWave(serializedTransaction, 1);
  const wave2 = (async () => { await sleep(25); return fanoutWave(serializedTransaction, 2); })();
  const wave3 = (async () => { await sleep(75); return fanoutWave(serializedTransaction, 3); })();

  const waves = await Promise.all([wave1, wave2, wave3]);
  const flat = waves.flat();
  if (!flat.some((r) => r.ok)) {
    throw new Error(`All broadcast paths failed: ${flat.map((r) => `${r.url}: ${r.status}`).join(' | ')}`);
  }
}

async function main() {
  const state = await readState();
  logState(state);

  if (CHECK_ONLY) return;

  try {
    safetyChecks(state);
  } catch (err) {
    console.log(`NOT ARMED: ${err.message}`);
    return;
  }

  const startMs = Number(state.publicDrop.startTime) * 1000;
  const msUntilStart = startMs - Date.now();

  if (msUntilStart > ARM_WINDOW_MS) {
    console.log(`Public mint is ${Math.ceil(msUntilStart / 60000)} minutes away; this pass exits and the persistent runner will retry.`);
    return;
  }

  if (!process.env.PRIVATE_KEY) {
    console.log('PRIVATE_KEY secret is not set. Diagnostic completed; cannot sign yet.');
    return;
  }

  const rawKey = process.env.PRIVATE_KEY.trim();
  const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(privateKey);
  if (!isAddressEqual(account.address, EXPECTED_WALLET)) {
    throw new Error(`Safety stop: secret signs as ${account.address}, expected ${EXPECTED_WALLET}.`);
  }

  const calldata = encodeFunctionData({
    abi: seaDropAbi,
    functionName: 'mintPublic',
    args: [NFT, OPENSEA_FEE_RECIPIENT, zeroAddress, 1n],
  });

  console.log(`ARMED for ${new Date(startMs).toISOString()}. Read RPC=${RPC_URL}`);
  console.log(`Broadcast fanout: ${BROADCAST_RPCS.join(' | ')}`);

  // Do all mutable state reads and signing before launch. Nothing expensive remains at T=0.
  const prepAt = Math.max(Date.now(), startMs - 4000);
  await waitUntilEpoch(prepAt);

  const latest = await readState();
  logState(latest);
  safetyChecks(latest);

  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: EXPECTED_WALLET, blockTag: 'pending' }),
    publicClient.estimateFeesPerGas(),
  ]);

  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1n;
  const baseMaxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 1n;
  const maxFeePerGas = baseMaxFee * 4n + maxPriorityFeePerGas;
  const gas = 300000n;
  const worstCaseGasCost = gas * maxFeePerGas;

  if (worstCaseGasCost > MAX_GAS_COST_WEI) {
    throw new Error(`Safety stop: max gas exposure ${worstCaseGasCost} wei exceeds MAX_GAS_COST_WEI=${MAX_GAS_COST_WEI}.`);
  }
  if (latest.balance < latest.publicDrop.mintPrice + worstCaseGasCost) {
    throw new Error(`Insufficient ETH for configured gas ceiling. Balance=${latest.balance} wei.`);
  }

  const serialized = await account.signTransaction({
    chainId: 4663,
    to: SEADROP,
    data: calldata,
    value: latest.publicDrop.mintPrice,
    gas,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  });

  const localHash = keccak256(serialized);
  console.log(`PRE-SIGNED ${localHash} nonce=${nonce} worstCaseGasWei=${worstCaseGasCost}`);

  // Pre-resolve DNS and establish warm TLS/HTTP connections immediately before the race.
  const warmAt = Math.max(Date.now(), startMs - 900);
  await waitUntilEpoch(warmAt);
  await warmBroadcastConnections();

  const sendAt = Math.max(Date.now(), startMs + SEND_OFFSET_MS);
  console.log(`LAUNCH target=${new Date(sendAt).toISOString()} offset=${SEND_OFFSET_MS}ms`);
  await waitUntilEpoch(sendAt);

  await ultraFastBroadcast(serialized);
  console.log(`SUBMITTED ${localHash}`);
  console.log(`Explorer: https://robinhoodchain.blockscout.com/tx/${localHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: localHash,
    confirmations: 1,
    timeout: 60_000,
    pollingInterval: 100,
  });

  if (receipt.status !== 'success') {
    throw new Error(`Mint transaction mined but reverted: ${localHash}`);
  }

  const finalState = await readState();
  console.log(`MINT CONFIRMED in block ${receipt.blockNumber}.`);
  console.log(`Wallet mint count is now ${finalState.minterNumMinted}.`);
}

main().catch((err) => {
  console.error('BOT ERROR:', err.shortMessage || err.message || err);
  process.exit(1);
});
