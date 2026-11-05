import type { PosRegister, PosRegisterList } from '@mercaria/shared-types';

/**
 * Which named registers a device at `locationId` may ring up on.
 *
 * None unless the store's plan currently honours named registers
 * (`attributionActive`): otherwise every sale is recorded on the location's
 * default register, so offering a choice would be offering nothing. Archived
 * registers and other locations' registers are never offered.
 */
export function registerChoices(
  list: PosRegisterList | undefined,
  locationId: string,
): PosRegister[] {
  if (!list?.attributionActive) return [];
  return list.registers.filter(
    (register) => register.locationId === locationId && !register.archivedAt,
  );
}

/**
 * The register this device's sales should name: the remembered one while it is
 * still offered here, otherwise `null` — the location's default register, which
 * is what every device used before named registers existed.
 */
export function activeRegisterFor(
  list: PosRegisterList | undefined,
  locationId: string,
  rememberedId: string | null,
): PosRegister | null {
  if (!rememberedId) return null;
  return registerChoices(list, locationId).find((register) => register.id === rememberedId) ?? null;
}
