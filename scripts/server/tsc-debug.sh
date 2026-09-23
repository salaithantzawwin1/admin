#!/usr/bin/env bash
docker run --rm -v /opt/admin/backend:/src:ro node:20-bookworm sh -c "
mkdir -p /tmp/repro/workflow /tmp/repro/inventory
cp /src/node_modules/.package-lock.json /tmp/ 2>/dev/null
cat > /tmp/repro/workflow/wf.service.ts <<'EOF'
export class WorkflowService {}
EOF
cat > /tmp/repro/workflow/wf.module.ts <<'EOF'
import { Module } from '@nestjs/common';
import { WorkflowService } from './wf.service';
@Module({
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
EOF
cat > /tmp/repro/inventory/inv.module.ts <<'EOF'
import { WorkflowService } from '../workflow/wf.module';
export const x = WorkflowService;
EOF
cd /tmp/repro
ln -s /src/node_modules node_modules
/src/node_modules/.bin/tsc --noEmit --module commonjs --target ES2021 --experimentalDecorators --skipLibCheck --esModuleInterop inventory/inv.module.ts 2>&1 | head -5
echo REPRO_DONE
"
