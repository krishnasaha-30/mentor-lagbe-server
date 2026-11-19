const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 9;
const MAX_PAGE = 10000;
const MAX_PAGE_SIZE = 24;
const MAX_SEARCH_LENGTH = 100;
const MAX_FILTER_LENGTH = 80;

function readTextParameter(query, name, maxLength) {
  const rawValue = query[name];

  if (rawValue === undefined) {
    return { value: "" };
  }

  if (typeof rawValue !== "string") {
    return { error: `${name} must be a single value.` };
  }

  const value = rawValue.trim();

  if (value.length > maxLength) {
    return { error: `${name} must be at most ${maxLength} characters.` };
  }

  return { value };
}

function readIntegerParameter(query, name, defaultValue, maxValue) {
  const rawValue = query[name];

  if (rawValue === undefined) {
    return { value: defaultValue };
  }

  if (
    typeof rawValue !== "string" ||
    !/^[1-9]\d*$/.test(rawValue) ||
    Number(rawValue) > maxValue
  ) {
    return { error: `${name} must be an integer between 1 and ${maxValue}.` };
  }

  return { value: Number(rawValue) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactMatch(value) {
  return new RegExp(`^${escapeRegExp(value)}$`, "i");
}

export function parseTuitionsQuery(query) {
  const search = readTextParameter(query, "q", MAX_SEARCH_LENGTH);
  const subject = readTextParameter(query, "subject", MAX_FILTER_LENGTH);
  const classLevel = readTextParameter(query, "classLevel", MAX_FILTER_LENGTH);
  const mode = readTextParameter(query, "mode", MAX_FILTER_LENGTH);
  const page = readIntegerParameter(query, "page", DEFAULT_PAGE, MAX_PAGE);
  const pageSize = readIntegerParameter(
    query,
    "limit",
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  const invalidParameter = [
    search,
    subject,
    classLevel,
    mode,
    page,
    pageSize,
  ].find((parameter) => parameter.error);

  if (invalidParameter) {
    return { error: invalidParameter.error };
  }

  const filter = {
    approvalStatus: "approved",
    isActive: true,
  };

  if (search.value) {
    const searchRegex = new RegExp(escapeRegExp(search.value), "i");
    filter.$or = [{ title: searchRegex }, { subject: searchRegex }];
  }

  if (subject.value) {
    filter.subject = exactMatch(subject.value);
  }

  if (classLevel.value) {
    filter.classLevel = exactMatch(classLevel.value);
  }

  if (mode.value) {
    filter.mode = exactMatch(mode.value);
  }

  return {
    filter,
    page: page.value,
    pageSize: pageSize.value,
    skip: (page.value - 1) * pageSize.value,
  };
}
