import { defineConfig } from 'vitest/config';
export default defineConfig({resolve:{alias:{'@oxy.so/db/migrate':'/home/nate/Oxy/Mercaria/.worktrees/1519-final-adoption-20261003/node_modules/@oxy.so/db/dist/cjs/migrate/index.js'}},test:{globals:true,environment:'node',include:['src/db/__tests__/deployCoverage.test.ts'],maxWorkers:1}});
