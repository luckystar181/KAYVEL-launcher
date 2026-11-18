import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { clientProcessorPlan, mavenPath, NEOFORGE_RUNTIME_FILES } from '../dist/main/prepare-neoforge.js';
import { PreparationFiles } from '../dist/main/preparation-files.js';

const neoform = '1.21.1-20240808.144430';
const tool = 'net.neoforged.installertools:installertools:2.1.2';
const root = join(process.cwd(), 'fictional-instance-never-created');
const files = new PreparationFiles(root);
function fixture() {
  const data = Object.fromEntries(Object.entries({
    MAPPINGS: `[net.neoforged:neoform:${neoform}:mappings@txt]`,
    MOJMAPS: `[net.minecraft:client:${neoform}:mappings@txt]`,
    MERGED_MAPPINGS: `[net.neoforged:neoform:${neoform}:mappings-merged@txt]`,
    BINPATCH: '/data/client.lzma',
    MC_SLIM: `[net.minecraft:client:${neoform}:slim]`,
    MC_EXTRA: `[net.minecraft:client:${neoform}:extra]`,
    MC_SRG: `[net.minecraft:client:${neoform}:srg]`,
    PATCHED: '[net.neoforged:neoforge:21.1.252:client]',
    MCP_VERSION: `'${neoform}'`
  }).map(([key, client]) => [key, { client }]));
  const processor = (jar, args, sides) => ({ jar, args, classpath: ['net.sf.jopt-simple:jopt-simple:5.0.4'], ...(sides ? { sides } : {}) });
  return { version: 'neoforge-21.1.252', minecraft: '1.21.1', data, libraries: [], processors: [
    processor(tool, ['--task', 'EXTRACT_FILES', '--output', '{UNUSED_SERVER_VALUE}'], ['server']),
    processor(tool, ['--task', 'MCP_DATA', '--input', `[net.neoforged:neoform:${neoform}@zip]`, '--output', '{MAPPINGS}', '--key', 'mappings']),
    processor(tool, ['--task', 'DOWNLOAD_MOJMAPS', '--version', '1.21.1', '--side', '{SIDE}', '--output', '{MOJMAPS}']),
    processor(tool, ['--task', 'MERGE_MAPPING', '--left', '{MAPPINGS}', '--right', '{MOJMAPS}', '--output', '{MERGED_MAPPINGS}', '--classes', '--fields', '--methods', '--reverse-right']),
    processor('net.neoforged.installertools:jarsplitter:2.1.2', ['--input', '{MINECRAFT_JAR}', '--slim', '{MC_SLIM}', '--extra', '{MC_EXTRA}', '--srg', '{MERGED_MAPPINGS}'], ['client']),
    processor('net.neoforged:AutoRenamingTool:2.0.3:all', ['--input', '{MC_SLIM}', '--output', '{MC_SRG}', '--names', '{MERGED_MAPPINGS}', '--ann-fix', '--ids-fix', '--src-fix', '--record-fix']),
    processor('net.neoforged.installertools:binarypatcher:2.1.2:fatjar', ['--clean', '{MC_SRG}', '--output', '{PATCHED}', '--apply', '{BINPATCH}'])
  ] };
}

test('NeoForge client planning substitutes controlled mappings download and excludes server processors', () => {
  const plan = clientProcessorPlan(fixture(), files);
  assert.deepEqual(plan.map(task => task.label), ['MCP_DATA', 'MERGE_MAPPING', 'jarsplitter', 'AutoRenamingTool', 'binarypatcher']);
  assert.equal(plan.length, 5);
  assert.ok(plan.every(task => task.args.every(arg => !/[{}]/.test(arg))));
  assert.ok(plan.every(task => task.classpath[0] === task.jar));
  assert.equal(plan[0].args[3], files.path(`libraries/net/neoforged/neoform/${neoform}/neoform-${neoform}.zip`));
  assert.ok(plan[1].args.includes(files.path(`libraries/net/minecraft/client/${neoform}/client-${neoform}-mappings.txt`)));
  assert.deepEqual(plan[2].outputs, [mavenPath(`net.minecraft:client:${neoform}:slim`), mavenPath(`net.minecraft:client:${neoform}:extra`)]);
  assert.deepEqual(plan.at(-1).outputs, [mavenPath('net.neoforged:neoforge:21.1.252:client')]);
  assert.equal(plan.at(-1).args.at(-1), files.path('.preparation/client.lzma'));
});

test('NeoForge runtime receipts require all FML-discovered artifacts, not just the patched client', () => {
  assert.deepEqual(NEOFORGE_RUNTIME_FILES, [
    mavenPath(`net.minecraft:client:${neoform}:srg`),
    mavenPath(`net.minecraft:client:${neoform}:extra`),
    mavenPath('net.neoforged:neoforge:21.1.252:client'),
    mavenPath('net.neoforged:neoforge:21.1.252:universal')
  ]);
});

for (const change of ['version', 'minecraft', 'count', 'order', 'unknown-variable', 'missing-output', 'outside-output']) {
  test(`NeoForge planner refuses ${change} before executing any processor`, () => {
    const profile = fixture();
    if (change === 'version') profile.version = 'neoforge-other';
    if (change === 'minecraft') profile.minecraft = '1.21.2';
    if (change === 'count') profile.processors.pop();
    if (change === 'order') profile.processors.reverse();
    if (change === 'unknown-variable') profile.processors[1].args.push('{UNKNOWN_VARIABLE}');
    if (change === 'missing-output') profile.processors[1].args = ['--task', 'MCP_DATA'];
    if (change === 'outside-output') profile.data.PATCHED.client = "'C:/outside.jar'";
    assert.throws(() => clientProcessorPlan(profile, files));
  });
}

test('Maven paths preserve classifiers and ZIP/TXT extensions while refusing unsafe coordinates', () => {
  assert.equal(mavenPath('net.neoforged:AutoRenamingTool:2.0.3:all'), 'libraries/net/neoforged/AutoRenamingTool/2.0.3/AutoRenamingTool-2.0.3-all.jar');
  assert.equal(mavenPath(`net.neoforged:neoform:${neoform}:mappings@txt`), `libraries/net/neoforged/neoform/${neoform}/neoform-${neoform}-mappings.txt`);
  for (const coordinate of ['../g:a:1', 'g:a:../../escape', 'g:a:1\\file', 'g:a:1:x:y', 'g:aux:1', 'g:a:1@../txt']) assert.throws(() => mavenPath(coordinate));
});
