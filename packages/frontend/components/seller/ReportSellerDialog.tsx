import type { DialogControlProps } from "@oxy.so/bloom/dialog";
import { AbuseReportDialog } from "@/components/reports/AbuseReportDialog";

/** Seller reports name the Oxy user, never a store id. */
export function ReportSellerDialog({
  oxyUserId,
  displayName,
  control,
}: {
  oxyUserId: string;
  displayName: string;
  control: DialogControlProps;
}) {
  return (
    <AbuseReportDialog
      reportedType="seller"
      reportedId={oxyUserId}
      displayName={displayName}
      control={control}
    />
  );
}
