import { prepareComputerUse } from './pack.mjs';

// Runs as a managed child so a first native build cannot block opening the dev client.
await prepareComputerUse(process.cwd(), { development: true });
