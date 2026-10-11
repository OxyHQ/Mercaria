import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateProduct } from '../api/products';
import { publishBulkStatus } from '../bulk-product-status-cache';
import {
  applyProductStatus,
  type BulkProductStatus,
  type SelectedProduct,
} from '../bulk-product-status';

export function useBulkProductStatus(storeId: string, allowed: boolean) {
  const client = useQueryClient();
  const mounted = useRef(true);
  const permission = useRef(allowed);
  const stopped = useRef(false);
  if (!allowed) stopped.current = true;
  permission.current = allowed;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const canContinue = () => mounted.current && permission.current && !stopped.current;
  return useMutation({
    mutationFn: ({
      products,
      status,
    }: {
      products: SelectedProduct[];
      status: BulkProductStatus;
    }) => {
      stopped.current = !permission.current;
      return applyProductStatus(
        products,
        status,
        (id, next) => updateProduct(storeId, id, { status: next }),
        canContinue,
      );
    },
    retry: false,
    onSuccess: (result) => publishBulkStatus(client, storeId, result, canContinue),
  });
}
