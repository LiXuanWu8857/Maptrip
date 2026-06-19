package com.maptrip.app;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android 浮動視窗：行程記錄中時，浮一張小卡片在其他 App（如導航）上方，
 * 顯示已過時間 / 里程 + 一顆「結束」按鈕；點卡片本體可叫回 Maptrip。
 *
 * 對應 iOS 的 Live Activity（鎖屏方塊），但 Android 用 SYSTEM_ALERT_WINDOW
 * 覆蓋在其他 App 上方（鎖屏時不顯示，這是 Android 平台限制）。
 *
 * JS 端用法（見 app.js 的 floatWin()）：
 *   hasPermission()      -> { granted: bool }
 *   requestPermission()  -> 跳系統「顯示在其他應用程式上層」設定頁
 *   show({elapsed,distance})
 *   update({elapsed,distance})
 *   hide()
 * 事件：notifyListeners("floatCommand", { action: "end" | "open" })
 */
@CapacitorPlugin(name = "FloatingWindow")
public class FloatingWindowPlugin extends Plugin {

    private WindowManager windowManager;
    private View floatingView;
    private TextView timeText;
    private TextView distText;
    private WindowManager.LayoutParams layoutParams;

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canDraw());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (canDraw()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        // 跳系統設定頁讓使用者手動允許「顯示在其他應用程式上層」
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("granted", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void show(final PluginCall call) {
        final int elapsed = call.getInt("elapsed", 0);
        final int distance = call.getInt("distance", 0);
        getActivity().runOnUiThread(() -> {
            if (!canDraw()) {
                call.reject("no-overlay-permission");
                return;
            }
            try {
                if (floatingView == null) buildView();
                setText(elapsed, distance);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void update(final PluginCall call) {
        final int elapsed = call.getInt("elapsed", 0);
        final int distance = call.getInt("distance", 0);
        getActivity().runOnUiThread(() -> {
            if (floatingView != null) setText(elapsed, distance);
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            removeView();
            call.resolve();
        });
    }

    // App 被銷毀時清掉浮窗，避免殘留
    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(this::removeView);
    }

    // ---- 私有實作 ----

    private boolean canDraw() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return Settings.canDrawOverlays(getContext());
    }

    private int dp(float v) {
        return Math.round(v * getContext().getResources().getDisplayMetrics().density);
    }

    private void buildView() {
        windowManager = (WindowManager) getContext().getSystemService(android.content.Context.WINDOW_SERVICE);

        // 卡片底（圓角深色）
        LinearLayout card = new LinearLayout(getContext());
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(14), dp(10), dp(10), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E6202124"));
        bg.setCornerRadius(dp(16));
        card.setBackground(bg);

        // 左側：時間 + 距離兩行
        LinearLayout textCol = new LinearLayout(getContext());
        textCol.setOrientation(LinearLayout.VERTICAL);

        timeText = new TextView(getContext());
        timeText.setTextColor(Color.WHITE);
        timeText.setTextSize(16);
        timeText.setText("🚕 00:00");

        distText = new TextView(getContext());
        distText.setTextColor(Color.parseColor("#9AA0A6"));
        distText.setTextSize(12);
        distText.setText("0 公尺");

        textCol.addView(timeText);
        textCol.addView(distText);

        // 點文字區 → 叫回 Maptrip
        textCol.setOnClickListener(v -> {
            notifyListeners("floatCommand", makeAction("open"));
            bringAppToFront();
        });

        // 右側：結束鈕
        Button endBtn = new Button(getContext());
        endBtn.setText("結束");
        endBtn.setTextColor(Color.WHITE);
        endBtn.setTextSize(13);
        endBtn.setAllCaps(false);
        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(Color.parseColor("#EA4335"));
        btnBg.setCornerRadius(dp(10));
        endBtn.setBackground(btnBg);
        endBtn.setPadding(dp(14), dp(6), dp(14), dp(6));
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        btnLp.leftMargin = dp(12);
        endBtn.setLayoutParams(btnLp);
        endBtn.setOnClickListener(v -> notifyListeners("floatCommand", makeAction("end")));

        card.addView(textCol);
        card.addView(endBtn);
        floatingView = card;

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        layoutParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            android.graphics.PixelFormat.TRANSLUCENT);
        layoutParams.gravity = Gravity.TOP | Gravity.START;
        layoutParams.x = dp(12);
        layoutParams.y = dp(80);

        enableDrag(card);
        windowManager.addView(floatingView, layoutParams);
    }

    // 整張卡片可拖曳到任意位置
    private void enableDrag(View handle) {
        handle.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float touchX, touchY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = layoutParams.x;
                        startY = layoutParams.y;
                        touchX = e.getRawX();
                        touchY = e.getRawY();
                        moved = false;
                        return false;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) (e.getRawX() - touchX);
                        int dy = (int) (e.getRawY() - touchY);
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                        layoutParams.x = startX + dx;
                        layoutParams.y = startY + dy;
                        if (windowManager != null && floatingView != null) {
                            windowManager.updateViewLayout(floatingView, layoutParams);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        // 有拖動就吃掉這次點擊，沒拖動才放行給子 View 的 onClick
                        return moved;
                }
                return false;
            }
        });
    }

    private void setText(int elapsedSec, int distanceM) {
        int m = elapsedSec / 60, s = elapsedSec % 60;
        timeText.setText(String.format("🚕 %02d:%02d", m, s));
        if (distanceM >= 1000) {
            distText.setText(String.format("%.1f 公里", distanceM / 1000.0));
        } else {
            distText.setText(distanceM + " 公尺");
        }
    }

    private void removeView() {
        if (windowManager != null && floatingView != null) {
            try { windowManager.removeView(floatingView); } catch (Exception ignored) {}
        }
        floatingView = null;
    }

    private void bringAppToFront() {
        try {
            Intent launch = getContext().getPackageManager()
                .getLaunchIntentForPackage(getContext().getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                getContext().startActivity(launch);
            }
        } catch (Exception ignored) {}
    }

    private JSObject makeAction(String action) {
        JSObject o = new JSObject();
        o.put("action", action);
        return o;
    }
}
