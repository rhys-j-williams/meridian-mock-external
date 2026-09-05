# Data classification — External system mocks

Classification of everything in this component: **Synthetic — Non Restricted**.

This component contains no customer data, no employee data and no production configuration. All
names, addresses, account numbers, card numbers, transactions, payees and balances are produced by
the seeded generator in `@meridian/domain-fixtures` and are safe to commit, screenshot and share
outside the bank.

Guarantees the fixture generator makes, and the ones this component relies on:

- Card numbers deliberately **fail** the Luhn check, so they cannot be mistaken for, or used as,
  real card numbers.
- Account numbers carry the fictional routing number `021000000`, which is inside the reserved test
  range and is not issued to any institution.
- Customer names are drawn from a generated name list, not from any real directory.
- Balances, transactions and merchant names are deterministic for a given seed, so screenshots in
  documentation stay stable.

If you find anything in this component that looks like real data, treat it as a data incident:
stop, do not push, and page the on-call GIS engineer through the standard incident channel.
