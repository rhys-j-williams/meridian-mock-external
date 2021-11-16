FROM verdaccio/verdaccio:5.29.2
# Same config.yaml as the in-process fallback, with the storage path made absolute: relative
# paths resolve against the config file, and /verdaccio/conf is root owned in this image while
# /verdaccio/storage belongs to the verdaccio user and is where compose mounts the volume.
# htpasswd is bind mounted by compose so a password change does not need a rebuild. TOOL-1188.
USER root
COPY --chown=10001:65533 config.yaml /verdaccio/conf/config.yaml
RUN sed -i 's#^storage: ./storage#storage: /verdaccio/storage#' /verdaccio/conf/config.yaml
USER 10001
