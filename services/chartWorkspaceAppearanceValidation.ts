import { defaultChartSettings } from './chartSettings';
import { CHART_DATE_FORMATS } from './chartTimeAxisFormat';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('Neplatné vnořené nastavení vzhledu. Současné rozložení zůstalo zachováno.'); };
export const validateWorkspaceTimeZone = (value: unknown): void => {
  if (typeof value !== 'string' || !value.trim()) return fail();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); } catch { throw new Error(`Neplatná časová zóna: ${value}. Současné rozložení zůstalo zachováno.`); }
};
// Partial saved values are valid: normal chart defaults fill absent fields.
// Unknown JSON fields remain round-trippable, but cannot replace known containers or primitives.
const validateJSON = (value: unknown, depth = 0): void => {
  if (depth > 50) return fail();
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail(); return; }
  if (Array.isArray(value)) { value.forEach(item => validateJSON(item, depth + 1)); return; }
  if (!record(value)) return fail();
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return fail();
    if (key.toLowerCase() === 'timezone') validateWorkspaceTimeZone(item);
    validateJSON(item, depth + 1);
  }
};
const matches = (value: unknown, rule: unknown): boolean => {
  if (rule === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (rule === 'null') return value === null;
  if (typeof rule === 'string') return typeof value === rule;
  if (Array.isArray(rule)) return rule.every(item => typeof item === 'string') ? rule.some(item => matches(value, item)) : Array.isArray(value) && value.every(item => matches(item, rule[0]));
  if (!record(rule)) return false;
  if (Array.isArray(rule.enum)) return rule.enum.includes(value);
  if (!record(value)) return false;
  return Object.entries(value).every(([key, item]) => item === undefined || !(key in rule) || matches(item, rule[key]));
};
const fromDefaults = (value: unknown): unknown => record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromDefaults(item)])) : typeof value;
const chartRules = fromDefaults(defaultChartSettings(true)) as Record<string, Record<string, unknown>>;
chartRules.symbol.precision = { enum: ['default', 'integer', ...Array.from({ length: 15 }, (_, i) => i + 1), '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128', '1/320'] };
for (const key of ['symbolLabel', 'previousDayClose', 'highAndLow']) (chartRules.scales[key] as Record<string, unknown>).name = 'boolean';
const buttons = { enum: ['hover', 'always', 'never'] };
const lines = { enum: ['solid', 'dotted', 'dashed', 'large-dashed', 'sparse-dotted'] };
chartRules.scales.scaleModeButtons = buttons;
chartRules.scales.placement = { enum: ['left', 'right', 'auto'] };
chartRules.scales.symbolLastValueMode = { enum: ['priceAndPercentage', 'valueAccordingToScale'] };
chartRules.scales.dateFormat = { enum: [...CHART_DATE_FORMATS] };
for (const key of ['symbolLabel', 'previousDayClose', 'highAndLow']) {
  const label = chartRules.scales[key] as Record<string, unknown>;
  label.lineExtent = { enum: ['full', 'fromPoint'] };
  (label.appearance as Record<string, unknown>).style = lines;
}
chartRules.canvas.backgroundType = { enum: ['solid', 'gradient'] };
chartRules.canvas.gridLines = { enum: ['both', 'vert', 'horz', 'none'] };
chartRules.canvas.watermark = { enum: ['hidden', 'ticker', 'interval', 'description'] };
chartRules.canvas.navigationButtons = buttons; chartRules.canvas.paneButtons = buttons;
chartRules.canvas.gridVertStyle = lines; chartRules.canvas.gridHorzStyle = lines;
for (const key of ['sessionBreak', 'crosshair']) (chartRules.canvas[key] as Record<string, unknown>).style = lines;
chartRules.trading.executionMarkerSize = { enum: ['small', 'medium', 'large'] };
// Data-only contracts mirror the supported indicator / fib / position setting
// interfaces without importing their dialogs, template transport or chart runtime.
const rules = {
  "FvgIndicatorSettings": {
    "enabled": "boolean",
    "bullColor": "string",
    "bearColor": "string",
    "bullOpacity": "number",
    "bearOpacity": "number",
    "fillOpacity": "number",
    "mitigatedTransparency": "number",
    "maxCount": "number",
    "labelText": "string",
    "labelSize": {
      "enum": [
        "tiny",
        "small",
        "medium"
      ]
    },
    "labelColor": "string",
    "boxes": "boolean",
    "paneLabels": "boolean",
    "statusInputs": "boolean",
    "visibility": {
      "minutes": "boolean",
      "minuteFrom": "number",
      "minuteTo": "number",
      "hours": "boolean",
      "hourFrom": "number",
      "hourTo": "number",
      "days": "boolean",
      "dayFrom": "number",
      "dayTo": "number"
    }
  },
  "StructureIndicatorSettings": {
    "enabled": "boolean",
    "showBos": "boolean",
    "showChoch": "boolean",
    "bullishColor": "string",
    "bearishColor": "string",
    "lineWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "textSize": {
      "enum": [
        "tiny",
        "small",
        "medium",
        "large"
      ]
    },
    "textBackground": "boolean",
    "textBackgroundColor": "string",
    "paneLabels": "boolean",
    "statusInputs": "boolean",
    "visibility": {
      "minutes": "boolean",
      "minuteFrom": "number",
      "minuteTo": "number",
      "hours": "boolean",
      "hourFrom": "number",
      "hourTo": "number",
      "days": "boolean",
      "dayFrom": "number",
      "dayTo": "number"
    }
  },
  "LevelsIndicatorSettings": {
    "showAsia": "boolean",
    "asiaColor": "string",
    "asiaStart": "number",
    "asiaEnd": "number",
    "showAsiaLines": "boolean",
    "showLondon": "boolean",
    "londonColor": "string",
    "londonStart": "number",
    "londonEnd": "number",
    "showLondonLines": "boolean",
    "showNewYork": "boolean",
    "newYorkColor": "string",
    "newYorkStart": "number",
    "newYorkEnd": "number",
    "showNewYorkLines": "boolean",
    "sessionLineWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "sessionLineStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "showSessionBoxes": "boolean",
    "sessionBoxTransparency": "number",
    "currentDay": "boolean",
    "priorDay": "boolean",
    "priorWeek": "boolean",
    "dayOpen": "boolean",
    "weekOpen": "boolean",
    "sessionHighLow": "boolean",
    "currentDayColor": "string",
    "priorDayColor": "string",
    "priorWeekColor": "string",
    "dayOpenColor": "string",
    "weekOpenColor": "string",
    "currentDayWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "currentDayStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "priorDayWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "priorDayStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "priorWeekWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "priorWeekStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "showOpen": "boolean",
    "openWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "openStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "lineWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "showVwap": "boolean",
    "showPrevVwap": "boolean",
    "showDeviations": "boolean",
    "vwapColor": "string",
    "bandsColor": "string",
    "deviation": "number",
    "dev1Multiplier": "number",
    "dev2Multiplier": "number",
    "prevVwapWidth": {
      "enum": [
        1,
        2,
        3,
        4
      ]
    },
    "prevVwapStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "timezone": "string",
    "showLabels": "boolean",
    "labelSize": {
      "enum": [
        "small",
        "medium",
        "large"
      ]
    },
    "extendLines": "number",
    "showZones": "boolean",
    "zoneSize": "number",
    "showOvernight": "boolean",
    "overnightColor": "string",
    "showCompass": "boolean",
    "compassColor": "string",
    "showInitialBalance": "boolean",
    "initialBalanceColor": "string",
    "rthOpenHour": "number",
    "rthOpenMinute": "number",
    "showBiasTable": "boolean",
    "paneLabels": "boolean",
    "statusInputs": "boolean",
    "visibility": {
      "minutes": "boolean",
      "minuteFrom": "number",
      "minuteTo": "number",
      "hours": "boolean",
      "hourFrom": "number",
      "hourTo": "number",
      "days": "boolean",
      "dayFrom": "number",
      "dayTo": "number"
    }
  },
  "FibRetracementSettings": {
    "levels": [
      {
        "value": "number",
        "visible": "boolean",
        "color": "string",
        "opacity": "number"
      }
    ],
    "trendLineVisible": "boolean",
    "trendLineColor": "string",
    "trendLineOpacity": "number",
    "trendLineWidth": "number",
    "trendLineStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "levelLineWidth": "number",
    "levelLineStyle": {
      "enum": [
        "solid",
        "dashed",
        "dotted"
      ]
    },
    "extend": {
      "enum": [
        "none",
        "left",
        "right",
        "both"
      ]
    },
    "oneColor": "boolean",
    "oneColorValue": "string",
    "oneColorOpacity": "number",
    "backgroundVisible": "boolean",
    "backgroundOpacity": "number",
    "reverse": "boolean",
    "showPrices": "boolean",
    "showLevels": "boolean",
    "labelsPosition": {
      "enum": [
        "left",
        "right"
      ]
    },
    "labelsVertical": {
      "enum": [
        "top",
        "middle",
        "bottom"
      ]
    },
    "showText": "boolean",
    "text": "string",
    "textPosition": {
      "enum": [
        "left",
        "right"
      ]
    },
    "textVertical": {
      "enum": [
        "top",
        "middle",
        "bottom"
      ]
    },
    "fontSize": "number",
    "logScale": "boolean",
    "locked": "boolean",
    "hidden": "boolean",
    "visibility": {
      "ticks": "boolean",
      "seconds": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "minutes": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "hours": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "days": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "weeks": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "months": {
        "enabled": "boolean",
        "min": "number",
        "max": "number"
      },
      "ranges": "boolean"
    },
    "runtimeTimeframeMinutes": "number"
  },
  "PositionDrawingSettings": {
    "accountSize": "number",
    "lotSize": "number",
    "risk": "number",
    "riskMode": {
      "enum": [
        "USD",
        "percent"
      ]
    },
    "leverage": "number",
    "tickSize": "number",
    "pointValue": "number",
    "intervalSeconds": "number",
    "initialBars": "number",
    "initialTicks": "number",
    "lineColor": "string",
    "stopColor": "string",
    "targetColor": "string",
    "textColor": "string",
    "fontSize": "number",
    "priceLabels": "boolean",
    "stats": "boolean",
    "compactStats": "boolean",
    "alwaysShowStats": "boolean",
    "showTargetPercent": "boolean",
    "showTargetTicks": "boolean",
    "showTargetAmount": "boolean",
    "showTargetPnl": "boolean",
    "showOpenPnl": "boolean",
    "showQuantity": "boolean",
    "showRiskReward": "boolean",
    "showStopPercent": "boolean",
    "showStopTicks": "boolean",
    "showStopAmount": "boolean",
    "showStopPnl": "boolean",
    "qtyPrecision": [
      "number",
      "null"
    ]
  }
};
const styleRules = { color: 'string', width: 'number', dashed: 'boolean', lineStyle: { enum: ['solid', 'dashed', 'dotted'] }, fill: ['string', 'null'], text: 'string', textColor: 'string', fontSize: 'number', textHorizontal: { enum: ['left', 'center', 'right'] }, textVertical: { enum: ['top', 'middle', 'bottom'] }, fib: rules.FibRetracementSettings, position: rules.PositionDrawingSettings };
export const validateWorkspaceDrawingStyle = (value: unknown): void => {
  validateJSON(value);
  if (!matches(value, styleRules)) return fail();
};
const envelope = (value: unknown, rule: unknown): void => {
  if (!record(value)) return fail();
  if ('__panelScoped' in value) {
    if (value.__panelScoped !== 1 || !record(value.panels)) return fail();
    if (value.shared !== undefined && !matches(value.shared, rule)) return fail();
    if (!Object.values(value.panels).every(item => matches(item, rule))) return fail();
  } else if (!matches(value, rule)) return fail();
};
export const validateWorkspaceAppearance = (value: unknown): void => {
  validateJSON(value);
  if (!record(value)) return fail();
  for (const [slot, item] of Object.entries(value)) {
    if (slot === 'chartSettings') envelope(item, chartRules);
    else if (slot === 'indicatorSettings') envelope(item, { fvg: rules.FvgIndicatorSettings, structure: rules.StructureIndicatorSettings, levels: rules.LevelsIndicatorSettings });
    else if (slot === 'drawingStyleDefaults' && record(item)) Object.values(item).forEach(validateWorkspaceDrawingStyle);
    else return fail();
  }
};
