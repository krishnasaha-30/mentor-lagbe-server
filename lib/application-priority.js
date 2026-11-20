export function prioritizeProStudentApplications(applications) {
  return [...applications].sort((left, right) => {
    const planPriority =
      Number(right.student?.plan === "pro") -
      Number(left.student?.plan === "pro");

    if (planPriority !== 0) {
      return planPriority;
    }

    const recentFirst =
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();

    return recentFirst || right.id.localeCompare(left.id);
  });
}
