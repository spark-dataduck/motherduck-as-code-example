# Agent commerce metrics

Canonical definitions for the `agent_commerce` dataset: tenants selling
machine-consumable services, and the AI agents that buy them.

## Rules

- **Revenue means authorized revenue.** Always filter on
  `transaction_status = 'authorized'`. Unfiltered sums overstate revenue by
  roughly 18%.
- **`refunded` is a sibling status, not a reversal.** A refunded transaction
  never appears as `authorized`, so summing authorized transactions does not
  net out refunds. To report net revenue, subtract the refunded total
  explicitly.
- **Join transactions to services with `USING (service_id)`**, and services to
  tenants with `USING (tenant_id)`. Never join transactions directly to tenants
  when you need service attributes — you will fan out the row count.
- **`service_state_history` is slowly changing.** It has `state_started_at` and
  no end column, and 1,776 of 2,200 services have more than one row. Always
  reduce to the latest state per service before joining.
- **Use `agent_commerce_marts.main.monthly_spend` for monthly totals.** It is
  refreshed weekly by the `agent-commerce-monthly-rollup` Flight and is cheaper
  than re-aggregating 110K transactions.

## Reference values

| Column | Values |
| --- | --- |
| `transaction_status` | `authorized` (90.0K), `declined` (9.9K), `refunded` (5.6K), `timeout` (4.4K) |
| `payment_protocol` | `x402` (59.7K), `MPP` (37.0K), `hosted_checkout` (13.3K) |
| `tenant_plan` | `starter`, `growth`, `scale`, `enterprise` |
| `service_status` | `live`, `beta`, `paused`, `deprecated` |
| `state_name` | `draft`, `storefront_generated`, `payment_configured`, `live`, `paused`, `retired` |

`agent_transactions.occurred_at` covers 2024-01-01 through 2024-12-31 only.

## Query patterns

Authorized revenue by tenant plan:

```sql
SELECT t.tenant_plan,
       sum(x.gross_amount_usd) FILTER (WHERE x.transaction_status = 'authorized') AS authorized_revenue
FROM agent_commerce.main.agent_transactions x
JOIN agent_commerce.main.tenants t USING (tenant_id)
GROUP BY ALL
ORDER BY authorized_revenue DESC;
```

Net revenue, subtracting refunds explicitly:

```sql
SELECT sum(gross_amount_usd) FILTER (WHERE transaction_status = 'authorized')
     - sum(gross_amount_usd) FILTER (WHERE transaction_status = 'refunded') AS net_revenue
FROM agent_commerce.main.agent_transactions;
```

Latest state per service:

```sql
SELECT service_id, state_name, state_started_at
FROM agent_commerce.main.service_state_history
QUALIFY row_number() OVER (PARTITION BY service_id ORDER BY state_started_at DESC) = 1;
```
