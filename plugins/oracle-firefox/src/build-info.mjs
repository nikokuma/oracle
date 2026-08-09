import { GENERATED_BUILD_INFO } from "./generated-build-info.mjs";

export const ORACLE_FIREFOX_VERSION = GENERATED_BUILD_INFO.packageVersion;
export const BROKER_PROTOCOL_VERSION = GENERATED_BUILD_INFO.protocolVersion;
export const BROKER_MINIMUM_READER_PROTOCOL = GENERATED_BUILD_INFO.minimumReaderProtocol;
export const BROKER_MINIMUM_WRITER_PROTOCOL = GENERATED_BUILD_INFO.minimumWriterProtocol;
export const BROKER_SCHEMA_VERSION = GENERATED_BUILD_INFO.schemaVersion;
export const BROKER_RELEASE_SEQUENCE = GENERATED_BUILD_INFO.releaseSequence;
export const BROKER_BUILD_ID = GENERATED_BUILD_INFO.buildId;
export const BROKER_SOURCE_DIGEST = GENERATED_BUILD_INFO.sourceDigest;

export function buildInfo() {
  return {
    packageVersion: ORACLE_FIREFOX_VERSION,
    protocolMinimum: BROKER_MINIMUM_READER_PROTOCOL,
    protocolMaximum: BROKER_PROTOCOL_VERSION,
    minimumWriterProtocol: BROKER_MINIMUM_WRITER_PROTOCOL,
    schemaVersion: BROKER_SCHEMA_VERSION,
    releaseSequence: BROKER_RELEASE_SEQUENCE,
    buildVersion: ORACLE_FIREFOX_VERSION,
    buildId: BROKER_BUILD_ID,
    sourceDigest: BROKER_SOURCE_DIGEST,
  };
}
