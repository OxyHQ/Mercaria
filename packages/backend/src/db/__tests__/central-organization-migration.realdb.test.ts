import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  applyMigrationsThrough,
  createMercariaTestDatabaseThrough,
  dropMercariaTestDatabase,
} from '../testDatabase.js';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';
let databaseUrl: string;
let client: postgres.Sql;
beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabaseThrough(adminUrl, '0165_youthful_rictor');
  client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
}, 300_000);
afterAll(async () => {
  await client?.end();
  if (databaseUrl) await dropMercariaTestDatabase(databaseUrl);
});

it('archives frozen facts, supports reference-only rollout writes and guards the destructive cutover', async () => {
  await client`insert into organizations(id,slug,name,normalized_name,legal_name,verified_domains)
    values ('company','company','Original Company','original company','Original Company Ltd',array['verified.example'])`;
  await client`insert into organizations(id,slug,name,normalized_name,status,merged_into_id)
    values ('old-company','old-company','Old Company','old company','merged','company')`;
  await client`insert into organization_aliases(id,organization_id,alias,kind) values ('alias','company','Former Company','former_name')`;
  await client`insert into brands(id,slug,name,normalized_name) values ('brand','brand','Brand','brand')`;
  await client`insert into commerce_relationships(id,kind,organization_id,brand_id,asserted_by_kind,created_by_oxy_user_id)
    values ('relationship','organization_owns_brand','company','brand','platform_verification','operator')`;
  const [before] =
    await client`select organization_id,brand_id,kind from commerce_relationships where id='relationship'`;

  await applyMigrationsThrough(databaseUrl, '0167_retire_local_organization_identity', 'pre');
  expect(
    await client`select name,legal_name,verified_domains from organization_identity_archives where organization_id='company'`,
  ).toEqual([
    {
      name: 'Original Company',
      legal_name: 'Original Company Ltd',
      verified_domains: ['verified.example'],
    },
  ]);
  await expect(
    client`update organizations set name='Local Edit' where id='company'`,
  ).rejects.toThrow('owned by Oxy');
  await expect(
    client`insert into organizations(id,slug,name,normalized_name) values ('old-writer','old-writer','Company','company')`,
  ).rejects.toThrow('canonical Oxy');
  await expect(
    client`insert into organization_aliases(id,organization_id,alias,kind) values ('new-alias','company','New Name','former_name')`,
  ).rejects.toThrow('immutable');
  await expect(
    client`update organization_aliases set alias='Edited' where id='alias'`,
  ).rejects.toThrow('immutable');
  await expect(client`delete from organization_aliases where id='alias'`).rejects.toThrow(
    'immutable',
  );
  await client`insert into organizations(id,slug,oxy_account_id) values ('new-reference','new-reference','oxy-new')`;
  await expect(
    applyMigrationsThrough(databaseUrl, '0167_retire_local_organization_identity', 'post'),
  ).rejects.toThrow();
  expect(await client`select name from organizations where id='company'`).toEqual([
    { name: 'Original Company' },
  ]);

  await client`update organizations set oxy_account_id='oxy-company' where id in ('company','old-company')`;
  await applyMigrationsThrough(databaseUrl, '0167_retire_local_organization_identity', 'post');
  expect(
    await client`select organization_id,brand_id,kind from commerce_relationships where id='relationship'`,
  ).toEqual([before]);
  expect(
    await client`select merged_into_id,oxy_account_id from organizations where id='old-company'`,
  ).toEqual([{ merged_into_id: 'company', oxy_account_id: 'oxy-company' }]);
  expect(
    await client`select organization_id,alias from organization_aliases where id='alias'`,
  ).toEqual([{ organization_id: 'company', alias: 'Former Company' }]);
  expect(await client`select count(*)::int as n from organizations`).toEqual([{ n: 3 }]);
  expect(
    await client`select column_name from information_schema.columns where table_schema='public' and table_name='organizations' and column_name in ('name','legal_name','website_url','logo_file_id','verified_domains','search_vector')`,
  ).toEqual([]);
  await expect(
    client`update organization_identity_archives set name='Changed' where organization_id='company'`,
  ).rejects.toThrow('immutable');
  await expect(
    client`delete from organization_identity_archives where organization_id='company'`,
  ).rejects.toThrow('immutable');
  await expect(
    client`insert into organizations(id,slug,oxy_account_id) values ('blank','blank',' ')`,
  ).rejects.toThrow();
}, 300_000);
