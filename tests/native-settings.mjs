// Harness 0.2.1 moved native Settings from a sidebar button into the account menu.
export async function openSettings(page, options) {
  await page.getByRole('button', { name: '账号菜单', exact: true }).click(options)
  await page.getByRole('menuitem', { name: '设置', exact: true }).click(options)
}
