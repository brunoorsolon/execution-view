/**
 * Phosphor icons (MIT, https://phosphoricons.com), bundled from
 * `@phosphor-icons/core` at build time. Every icon used here is a single
 * `<path>` on a 256x256 viewBox; only its `d` attribute is taken.
 */
import arrowRight from '@phosphor-icons/core/assets/regular/arrow-right.svg?raw';
import arrowSquareOut from '@phosphor-icons/core/assets/regular/arrow-square-out.svg?raw';
import arrowUUpLeft from '@phosphor-icons/core/assets/regular/arrow-u-up-left.svg?raw';
import arrowsClockwise from '@phosphor-icons/core/assets/regular/arrows-clockwise.svg?raw';
import caretDown from '@phosphor-icons/core/assets/regular/caret-down.svg?raw';
import checkBold from '@phosphor-icons/core/assets/bold/check-bold.svg?raw';
import checkCircle from '@phosphor-icons/core/assets/regular/check-circle.svg?raw';
import circleHalf from '@phosphor-icons/core/assets/regular/circle-half.svg?raw';
import cornersOut from '@phosphor-icons/core/assets/regular/corners-out.svg?raw';
import downloadSimple from '@phosphor-icons/core/assets/regular/download-simple.svg?raw';
import funnelSimple from '@phosphor-icons/core/assets/regular/funnel-simple.svg?raw';
import graph from '@phosphor-icons/core/assets/regular/graph.svg?raw';
import info from '@phosphor-icons/core/assets/regular/info.svg?raw';
import listNumbers from '@phosphor-icons/core/assets/regular/list-numbers.svg?raw';
import magnifyingGlass from '@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw';
import minus from '@phosphor-icons/core/assets/regular/minus.svg?raw';
import path from '@phosphor-icons/core/assets/regular/path.svg?raw';
import plus from '@phosphor-icons/core/assets/regular/plus.svg?raw';
import warning from '@phosphor-icons/core/assets/regular/warning.svg?raw';
import warningCircle from '@phosphor-icons/core/assets/regular/warning-circle.svg?raw';
import x from '@phosphor-icons/core/assets/regular/x.svg?raw';

function pathOf(source: string): string {
  const d = /\sd="([^"]+)"/.exec(source)?.[1];
  if (d === undefined) throw new Error('icon without a path');
  return d;
}

const SOURCES = {
  alert: warningCircle,
  arrow: arrowRight,
  check: checkBold,
  checkCircle,
  chevron: caretDown,
  close: x,
  critical: path,
  download: downloadSimple,
  external: arrowSquareOut,
  filter: funnelSimple,
  fit: cornersOut,
  graph,
  info,
  loop: arrowUUpLeft,
  minus,
  order: listNumbers,
  plus,
  refresh: arrowsClockwise,
  search: magnifyingGlass,
  theme: circleHalf,
  warning,
} as const;

export type IconName = keyof typeof SOURCES;

/** Path data per icon name, 256x256 viewBox. */
export const ICON_PATHS = Object.fromEntries(
  Object.entries(SOURCES).map(([name, src]) => [name, pathOf(src)]),
) as Record<IconName, string>;
