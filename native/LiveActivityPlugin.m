// ⚠️ 此檔案只加入「主 App target（App）」，不要加入 Widget Extension

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(LiveActivityPlugin, "LiveActivity",
    CAP_PLUGIN_METHOD(initActivity, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startTrip,    CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(updateTrip,   CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(endTrip,      CAPPluginReturnPromise);
)
