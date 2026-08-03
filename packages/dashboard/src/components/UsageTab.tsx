import type { SessionSummary } from "@agentrec/core/browser";
import type { ReactElement } from "react";
import { formatCost, formatCount, formatTokens, shortModel } from "../lib/format";

export function UsageTab(props: { summary: SessionSummary }): ReactElement {
  const { summary } = props;
  const tools = Object.entries(summary.toolCounts).sort((a, b) => b[1] - a[1]);
  const busiest = tools[0]?.[1] ?? 1;
  const cacheWrite = (usage: SessionSummary["totalUsage"]): number =>
    usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens;

  return (
    <div className="usage">
      <section className="usage-block">
        <h3 className="usage-title">Models</h3>
        {summary.models.length === 0 ? (
          <p className="pane-placeholder">No token usage was captured for this session.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>model</th>
                <th className="num">req</th>
                <th className="num">in</th>
                <th className="num">cache r</th>
                <th className="num">cache w</th>
                <th className="num">out</th>
                <th className="num">cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.models.map((model) => (
                <tr key={model.model}>
                  <td className="mono">{shortModel(model.model)}</td>
                  <td className="num">{formatCount(model.requests)}</td>
                  <td className="num">{formatTokens(model.usage.inputTokens)}</td>
                  <td className="num">{formatTokens(model.usage.cacheReadInputTokens)}</td>
                  <td className="num">{formatTokens(cacheWrite(model.usage))}</td>
                  <td className="num">{formatTokens(model.usage.outputTokens)}</td>
                  <td className="num">{formatCost(model.costUsd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>total</td>
                <td className="num">
                  {formatCount(summary.models.reduce((sum, m) => sum + m.requests, 0))}
                </td>
                <td className="num">{formatTokens(summary.totalUsage.inputTokens)}</td>
                <td className="num">{formatTokens(summary.totalUsage.cacheReadInputTokens)}</td>
                <td className="num">{formatTokens(cacheWrite(summary.totalUsage))}</td>
                <td className="num">{formatTokens(summary.totalUsage.outputTokens)}</td>
                <td className="num">{formatCost(summary.totalCostUsd)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      <section className="usage-block">
        <h3 className="usage-title">
          Tool calls <span className="usage-note">{formatCount(summary.toolCalls)} total</span>
        </h3>
        {tools.length === 0 ? (
          <p className="pane-placeholder">No tool calls were recorded.</p>
        ) : (
          <ul className="bars">
            {tools.map(([name, count]) => (
              <li key={name} className="bar">
                <span className="bar-name">{name}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${String((count / busiest) * 100)}%` }}
                  />
                </span>
                <span className="bar-value">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="usage-block">
        <h3 className="usage-title">
          Files changed{" "}
          <span className="usage-note">{formatCount(summary.filesChanged.length)}</span>
        </h3>
        {summary.filesChanged.length === 0 ? (
          <p className="pane-placeholder">No files were changed.</p>
        ) : (
          <ul className="file-list">
            {summary.filesChanged.map((path) => (
              <li key={path} className="mono">
                {path}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
