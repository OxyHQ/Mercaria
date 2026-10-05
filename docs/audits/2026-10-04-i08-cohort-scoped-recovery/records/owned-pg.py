#!/usr/bin/env python3
"""Move package tests using only a freshly initialized, verified local PG process."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path('/home/nate/Oxy/Mercaria/.worktrees/1519-billing-cohort-functional-20261004')
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5627


def main():
    if len(os.sys.argv) != 1:
        raise SystemExit('Runtime/connection overrides are not accepted')
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}
    own = Path(tempfile.mkdtemp(prefix='mcohort-pg-', dir='/home/nate/Oxy/.agent-evidence'))
    (own / 'tmp').mkdir()
    env['TMPDIR'] = str(own / 'tmp')
    data = own / 'data'
    def run(argv, **kw):
        return subprocess.run([str(x) for x in argv], env=env, text=True, check=True, **kw)
    started = int(time.time())
    run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale'], stdout=subprocess.DEVNULL)
    active = False
    pid = None
    try:
        run([PG / 'pg_ctl', '-D', data, '-l', own / 'server.log', '-w', '-o', f'-h 127.0.0.1 -p {PORT} -k {own} -c max_locks_per_transaction=256', 'start'])
        active = True
        state = (data / 'postmaster.pid').read_text().splitlines()
        pid = int(state[0])
        assert Path(state[1]).resolve() == data.resolve() and int(state[2]) >= started and int(state[3]) == PORT
        assert Path(f'/proc/{pid}').stat().st_uid == os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve() == (PG / 'postgres').resolve()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert b'-D' in args and str(data).encode() in args
        sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
        rows = [r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:]]
        matches = [r for r in rows if r[1] == f'0100007F:{PORT:04X}' and r[3] == '0A']
        assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets
        # Descendants of package scripts also disable Bun dotenv auto-loading.
        real_bun = subprocess.check_output(['which', 'bun'], env=env, text=True).strip()
        wrappers = own / 'bin'
        wrappers.mkdir()
        wrapper = wrappers / 'bun'
        wrapper.write_text('#!/bin/sh\nexec ' + real_bun + ' --no-env-file "$@"\n')
        wrapper.chmod(0o700)
        env |= {'PATH': str(wrappers) + ':' + env['PATH'], 'TEST_DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/postgres', 'NODE_ENV': 'test'}
        print(json.dumps({'verifiedOwnPostgresPid': pid, 'dataDirectory': str(data), 'port': PORT, 'liveAccess': False}), flush=True)
        run([PG / 'psql', '-h', '127.0.0.1', '-p', str(PORT), '-U', 'oxy', '-d', 'template1', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE EXTENSION postgis;'], stdout=subprocess.DEVNULL)
        evidence = Path('/home/nate/Oxy/.agent-evidence/integration-mercaria-scoped-recovery-20261004')
        targets = ['src/config/__tests__/billing-cohort.test.ts', 'src/routes/__tests__/billing-cohort-stripe.integration.test.ts']
        phase = os.environ.get('I08_EVIDENCE_PHASE', 'red')
        changed = subprocess.check_output(['git','diff','--name-only'],cwd=ROOT,text=True).splitlines()
        source_inputs = {path:(ROOT/path).read_bytes() for path in changed if '/src/' in path and '/__tests__/' not in path}
        if phase == 'red':
            for path in source_inputs:
                (ROOT/path).write_bytes(subprocess.check_output(['git','show','dbb74603:'+path],cwd=ROOT))
        try:
            for enabled in ('false','true'):
                env['I08_TEST_ACTIONS'] = enabled
                with (evidence / (phase + '-accepted-fixture-actions-' + enabled + '.log')).open('w') as log:
                    tested = subprocess.run(['bun', 'run', 'test', *targets], cwd=ROOT / 'packages/backend', env=env, text=True, stdout=log, stderr=subprocess.STDOUT)
                print(json.dumps({'phase':phase,'actions':enabled,'exitCode':tested.returncode}), flush=True)
                if phase == 'green' and tested.returncode: raise RuntimeError('Scoped recovery fixture failed')
                if phase == 'red' and not tested.returncode: raise RuntimeError('Baseline unexpectedly passed')
        finally:
            for path, content in source_inputs.items(): (ROOT/path).write_bytes(content)
    finally:
        if active:
            run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
            assert pid is not None and not Path(f'/proc/{pid}').exists()
        print(json.dumps({'ownedPostgresStopped': active, 'pidAbsent': pid is None or not Path(f'/proc/{pid}').exists(), 'record': str(own)}), flush=True)


if __name__ == '__main__':
    main()
