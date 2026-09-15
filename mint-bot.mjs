import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddressEqual,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const NFT = '0x116eaa62241751e0c98da43d458600c6c17cd361';
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';
const EXPECTED_WALLET = '0x810746D67175869935c0152a55f77Aa40C6f299c';
const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const MAX_MINT_VALUE_WEI = BigInt(process.env.MAX_MINT_VALUE_WEI || '0');
const ARM_WINDOW_MS = Number(process.env.ARM_WINDOW_MS || 45 * 60 * 1000);
const SEND_OFFSET_MS = Number(process.env.SEND_OFFSET_MS || 75);
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
  transport: http(RPC_URL, { timeout: 10_000, retryCount: 3, retryDelay: 150 }),
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

async function waitUntil(targetMs) {
  while (true) {
    const left = targetMs - Date.now();
    if (left <= 0) return;
    if (left > 30_000) await sleep(Math.min(30_000, left - 20_000));
    else if (left > 2_000) await sleep(Math.max(250, left - 1_000));
    else if (left > 200) await sleep(Math.max(25, left - 100));
    else await sleep(Math.min(10, Math.max(1, left)));
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
    console.log(`Public mint is ${Math.ceil(msUntilStart / 60000)} minutes away; this cron run exits. A later run will arm automatically.`);
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

  const walletClient = createWalletClient({
    account,
    chain: robinhood,
    transport: http(RPC_URL, { timeout: 10_000, retryCount: 3, retryDelay: 100 }),
  });

  const calldata = encodeFunctionData({
    abi: seaDropAbi,
    functionName: 'mintPublic',
    args: [NFT, OPENSEA_FEE_RECIPIENT, zeroAddress, 1n],
  });

  if (msUntilStart > 0) {
    console.log(`ARMED. Public mint starts ${new Date(startMs).toISOString()}. Preparing a pre-signed transaction.`);
  } else {
    console.log('ARMED. Public mint time has already arrived; preparing transaction now.');
  }

  // Refresh mutable transaction fields shortly before the boundary.
  const prepAt = Math.max(Date.now(), startMs - 2500);
  await waitUntil(prepAt);

  let latest = await readState();
  logState(latest);
  safetyChecks(latest);

  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: EXPECTED_WALLET, blockTag: 'pending' }),
    publicClient.estimateFeesPerGas(),
  ]);

  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1n;
  const maxFeePerGas = (fees.maxFeePerGas ?? fees.gasPrice ?? 1n) * 2n + maxPriorityFeePerGas;

  const serialized = await account.signTransaction({
    chain: robinhood,
    to: SEADROP,
    data: calldata,
    value: latest.publicDrop.mintPrice,
    gas: 300000n,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  });

  const sendAt = Math.max(Date.now(), startMs + SEND_OFFSET_MS);
  console.log(`Transaction pre-signed with nonce ${nonce}. Broadcasting at ${new Date(sendAt).toISOString()} (offset ${SEND_OFFSET_MS}ms).`);
  await waitUntil(sendAt);

  let hash;
  try {
    hash = await publicClient.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    console.error(`Initial broadcast error: ${err.shortMessage || err.message}`);
    // One immediate rebroadcast of the identical signed transaction protects against a transient RPC failure without creating a second mint nonce.
    await sleep(100);
    hash = await publicClient.sendRawTransaction({ serializedTransaction: serialized });
  }

  console.log(`SUBMITTED ${hash}`);
  console.log(`Explorer: https://robinhoodchain.blockscout.com/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
  if (receipt.status !== 'success') {
    throw new Error(`Mint transaction mined but reverted: ${hash}`);
  }

  const finalState = await readState();
  console.log(`MINT CONFIRMED in block ${receipt.blockNumber}.`);
  console.log(`Wallet mint count is now ${finalState.minterNumMinted}. Cloud bot stopping.`);
}

main().catch((err) => {
  console.error('BOT ERROR:', err.shortMessage || err.message || err);
  process.exit(1);
});
