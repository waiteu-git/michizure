import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        excludeWebViewDataFromBackup()
        return true
    }

    /**
     🔴 端末の控えを、端末の外へ出さない（2026-09-10）。

     WebView の保存領域（Library/WebKit）には、部屋の中身の**平文**・同期の土台（これも平文）・
     **暗号を解く鍵**・接続用のトークンが入る。iOS は既定でこれを iCloud バックアップに含めるので、
     端末の外に写しができ、「この端末から消す」がその写しに届かない。
     ⇒ プライバシーポリシーの「端末の中だけ」が嘘になる（Android でも同じ欠陥があり、先に直した）。

     ⚠ 印を付けられるのは在る物だけなので、まだ無ければ先に作る。
     ⚠ 起動のたびに付け直す。WebKit が領域を作り直した場合に印が落ちるため。
     ⚠ 失うもの: 機種変更で部屋の控えが引き継がれない。合言葉で入り直せば戻る（設計どおり）。
     */
    private func excludeWebViewDataFromBackup() {
        let fm = FileManager.default
        guard let library = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
        var dir = library.appendingPathComponent("WebKit", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try dir.setResourceValues(values)
        } catch {
            NSLog("Michizure: WebView の保存領域をバックアップから外せなかった: \(error)")
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
