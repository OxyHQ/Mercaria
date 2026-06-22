/**
 * Unit tests for `store-authz`.
 *
 * Covers the `ROLE_PERMISSIONS` matrix, `effectivePermissions` (role defaults ∪
 * explicit member grants), and the `requireStoreRole` / `requireStorePermission`
 * guards. No DB needed — these operate on `req.storeMembership`, which `loadStore`
 * attaches upstream (tested via integration/smoke).
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { StorePermission } from '@mercaria/shared-types';

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  ROLE_PERMISSIONS,
  effectivePermissions,
  requireStoreRole,
  requireStorePermission,
} from '../store-authz.js';
import type { IStoreMember } from '../../models/store.js';

function member(role: IStoreMember['role'], permissions: StorePermission[] = []): IStoreMember {
  return { oxyUserId: 'u1', role, permissions, joinedAt: new Date() };
}

function mockReq(membership?: IStoreMember): Request {
  return { storeMembership: membership } as unknown as Request;
}

function mockRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe('ROLE_PERMISSIONS matrix', () => {
  it('owner holds every permission including store:manage, members:manage, locations:write, collections:write, discounts:write and settings:write', () => {
    const owner = new Set(ROLE_PERMISSIONS.owner);
    expect(owner.has('store:manage')).toBe(true);
    expect(owner.has('members:manage')).toBe(true);
    expect(owner.has('products:write')).toBe(true);
    expect(owner.has('locations:write')).toBe(true);
    expect(owner.has('collections:write')).toBe(true);
    expect(owner.has('discounts:write')).toBe(true);
    expect(owner.has('settings:write')).toBe(true);
    expect(owner.has('customers:read')).toBe(true);
    expect(owner.has('customers:write')).toBe(true);
    expect(owner.has('draft_orders:write')).toBe(true);
    expect(owner.size).toBe(15);
  });

  it('admin holds everything except store:manage (incl. discounts:write, settings:write)', () => {
    const admin = new Set(ROLE_PERMISSIONS.admin);
    expect(admin.has('store:manage')).toBe(false);
    expect(admin.has('members:manage')).toBe(true);
    expect(admin.has('products:write')).toBe(true);
    expect(admin.has('inventory:write')).toBe(true);
    expect(admin.has('locations:write')).toBe(true);
    expect(admin.has('collections:write')).toBe(true);
    expect(admin.has('discounts:write')).toBe(true);
    expect(admin.has('settings:write')).toBe(true);
  });

  it('staff covers products/inventory/orders/stats + customers/draft_orders (POS), with no manage/discounts/settings', () => {
    const staff = new Set(ROLE_PERMISSIONS.staff);
    expect(staff.has('store:manage')).toBe(false);
    expect(staff.has('members:manage')).toBe(false);
    expect(staff.has('locations:write')).toBe(false);
    expect(staff.has('collections:write')).toBe(false);
    expect(staff.has('discounts:write')).toBe(false);
    expect(staff.has('settings:write')).toBe(false);
    expect(staff.has('products:read')).toBe(true);
    expect(staff.has('products:write')).toBe(true);
    expect(staff.has('inventory:write')).toBe(true);
    expect(staff.has('orders:read')).toBe(true);
    expect(staff.has('orders:fulfill')).toBe(true);
    expect(staff.has('stats:read')).toBe(true);
    // Staff run the POS: customers + draft orders.
    expect(staff.has('customers:read')).toBe(true);
    expect(staff.has('customers:write')).toBe(true);
    expect(staff.has('draft_orders:write')).toBe(true);
  });
});

describe('effectivePermissions', () => {
  it('unions a member\'s explicit grants with their role defaults', () => {
    const staffPlus = member('staff', ['members:manage']);
    const effective = effectivePermissions(staffPlus);
    expect(effective.has('members:manage')).toBe(true); // explicit grant
    expect(effective.has('products:write')).toBe(true); // role default
    expect(effective.has('store:manage')).toBe(false); // neither
  });
});

describe('requireStorePermission', () => {
  it('blocks staff from members:manage by default (403)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('members:manage')(mockReq(member('staff')), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks staff from store:manage (403)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('store:manage')(mockReq(member('staff')), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows admin members:manage', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('members:manage')(mockReq(member('admin')), res, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('allows owner store:manage', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('store:manage')(mockReq(member('owner')), res, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('allows a staff member EXPLICITLY granted members:manage (union)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('members:manage')(
      mockReq(member('staff', ['members:manage'])),
      res,
      next as NextFunction,
    );
    expect(next).toHaveBeenCalled();
  });

  it('rejects when there is no membership at all (403)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStorePermission('products:read')(mockReq(undefined), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireStoreRole', () => {
  it('allows a member whose role is in the allowed set', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStoreRole('owner', 'admin')(mockReq(member('admin')), res, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('blocks a member whose role is not allowed (403)', () => {
    const res = mockRes();
    const next = vi.fn();
    requireStoreRole('owner')(mockReq(member('staff')), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
