export async function runCoupledService(
  controller: AbortController,
  dispatcher: Promise<void>,
  viewer: Promise<void>,
): Promise<void> {
  try {
    await Promise.all([dispatcher, viewer]);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([dispatcher, viewer]);
    throw error;
  }
}
