// FILE: ComposerUsageBadge.tsx
// Purpose: Show the selected provider's remaining usage inline in the composer footer.
// Layer: Chat composer presentation
// Depends on: shared rate-limit derivation, global thread store, and shared popover/button styling.

import { type ProviderKind } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { ChevronDownIcon } from "~/lib/icons";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import {
  deriveVisibleRateLimitRows,
  formatRateLimitRemainingPercent,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import { cn } from "~/lib/utils";

import { ProviderUsagePanelContent, providerUsageLabel } from "../ProviderUsagePanelContent";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME } from "./composerPickerStyles";

function buildPrimaryUsageLabel(input: {
  readonly label: string;
  readonly remainingPercent: number;
}): string {
  const remaining = formatRateLimitRemainingPercent(input.remainingPercent);
  if (input.label === "Current") {
    return `${remaining} left`;
  }
  return `${input.label} ${remaining} left`;
}

function buildUsageLineLabel(input: OpenUsageUsageLine): string {
  return `${input.label} ${input.value}`;
}

export const ComposerUsageBadge = memo(function ComposerUsageBadge(props: {
  provider: ProviderKind;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines?: ReadonlyArray<OpenUsageUsageLine>;
  isLoading?: boolean;
}) {
  const visibleRows = useMemo(
    () => deriveVisibleRateLimitRows(props.rateLimits),
    [props.rateLimits],
  );
  const primaryRow = visibleRows[0] ?? null;
  const primaryUsageLine = props.usageLines?.[0] ?? null;
  const inlineLabel = primaryRow
    ? buildPrimaryUsageLabel(primaryRow)
    : primaryUsageLine
      ? buildUsageLineLabel(primaryUsageLine)
      : props.isLoading
        ? "Loading usage..."
        : providerUsageLabel(props.provider);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 sm:px-3",
              COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
            )}
            title={providerUsageLabel(props.provider)}
          />
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <span>{inlineLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        sideOffset={8}
        className="w-52 p-3 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:0px]"
      >
        <ProviderUsagePanelContent
          provider={props.provider}
          rateLimits={props.rateLimits}
          usageLines={props.usageLines}
          isLoading={props.isLoading}
        />
      </PopoverPopup>
    </Popover>
  );
});
