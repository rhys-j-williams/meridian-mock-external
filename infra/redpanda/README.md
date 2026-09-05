# redpanda

Single node Redpanda v23.3 on 9092 standing in for the Kafka cluster (Confluent Platform in the
bank, the `evt-*` cluster). Topics created by the `redpanda-topics` one-shot container:
ACCT.EVENTS, BEACON.OUT, BEACON.DLQ, AUDIT.TRAIL, TXN.POSTED, 3 partitions each, auto-create on
for anything else.

Fallback without Docker: Spring profile `local-inmem-kafka` in the Java services swaps the
KafkaTemplate for an in-memory queue. Ordering per key is preserved, nothing else is. Good enough
for smoke.sh's "three events for one customer, in order" check, which is the point.

`rpk` is inside the container: `docker exec estate-redpanda rpk topic consume ACCT.EVENTS`.
