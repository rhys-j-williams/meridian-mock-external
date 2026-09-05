# artemis (local-artemis profile)

Embedded/containerised ActiveMQ Artemis 2.31 standing in for IBM MQ when the MQ developer image
cannot be pulled (which on the build agents is always, PLAT-2301). The Java services select it with
`SPRING_PROFILES_ACTIVE=local-artemis`; the JMS abstraction is the same, only the ConnectionFactory
changes. Queues ACCT.EVENTS, BEACON.OUT, BEDROCK.REQ, BEDROCK.RESP are created at boot from
EXTRA_ARGS in docker-compose.yml.

Ports: 61616 core/JMS, 61613 STOMP (used by bedrock-core-mock), 8161 console
(artemis / CHANGEME-artemis).

In-process fallback when Docker is absent: the Java services embed Artemis themselves under the same
profile (see platform-services/libs/java/meridian-messaging), and bedrock-core-mock falls back to its
own in-memory BEDROCK.REQ/RESP pair with the REST facade on 4600 as the way in. Nothing in
mock-external starts a broker without Docker.

Known differences from MQ worth remembering before you blame the code:
- no MQRFH2 header; the bedrock-adapter strips it conditionally (BedrockMessageCodec)
- message expiry units differ (ms vs tenths of a second). It bit us in PLAT-2655.
- Artemis is happy to auto-create queues on first send; MQ is not. If a queue "works locally" and
  2035s in UAT, that is why.
