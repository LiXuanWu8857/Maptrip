package com.maptrip.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android 浮動視窗：常駐浮在其他 App 上方的行程小卡片。
 *  - 閒置：顯示「開始」按鈕
 *  - 記錄中：顯示時間 / 里程 + 「結束」按鈕
 *  - 按結束後：浮出數字鍵盤輸入車資
 * 整張卡片可任意拖曳；App 被關閉（Activity 銷毀）時浮窗才消失。
 *
 * JS 端用法（見 app.js 的 floatWin()）：
 *   hasPermission() / requestPermission()
 *   showIdle()                      閒置狀態
 *   showRecording({elapsed,distance})
 *   update({elapsed,distance})
 *   promptFare()                    顯示車資鍵盤
 *   hide()
 * 事件：
 *   floatCommand { action: "start" | "end" }
 *   floatFare    { value: 金額(int) }
 */
@CapacitorPlugin(name = "FloatingWindow")
public class FloatingWindowPlugin extends Plugin {

    private WindowManager wm;
    private DragLayout root;
    private WindowManager.LayoutParams lp;

    private LinearLayout mainRow;
    private LinearLayout textCol;
    private TextView titleText;
    private TextView subText;
    private Button actionBtn;
    private LinearLayout keypad;
    private TextView fareDisplay;

    private String mode = "idle";     // "idle" | "recording"
    private String fareStr = "";

    // ---- 權限 ----

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", canDraw());
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (canDraw()) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        JSObject r = new JSObject();
        r.put("granted", false);
        call.resolve(r);
    }

    // ---- 狀態切換 ----

    @PluginMethod
    public void showIdle(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!canDraw()) { call.reject("no-overlay-permission"); return; }
            try {
                if (root == null) buildView();
                setIdle();
                call.resolve();
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PluginMethod
    public void showRecording(final PluginCall call) {
        final int elapsed = call.getInt("elapsed", 0);
        final int distance = call.getInt("distance", 0);
        getActivity().runOnUiThread(() -> {
            if (!canDraw()) { call.reject("no-overlay-permission"); return; }
            try {
                if (root == null) buildView();
                setRecording(elapsed, distance);
                call.resolve();
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PluginMethod
    public void update(final PluginCall call) {
        final int elapsed = call.getInt("elapsed", 0);
        final int distance = call.getInt("distance", 0);
        getActivity().runOnUiThread(() -> {
            if (root != null && "recording".equals(mode)) setText(elapsed, distance);
            call.resolve();
        });
    }

    @PluginMethod
    public void promptFare(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (root != null) showKeypad();
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(final PluginCall call) {
        getActivity().runOnUiThread(() -> { removeView(); call.resolve(); });
    }

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
        Context ctx = getContext();
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

        root = new DragLayout(ctx);

        LinearLayout card = new LinearLayout(ctx);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(10), dp(10), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#F2202124"));
        bg.setCornerRadius(dp(16));
        card.setBackground(bg);

        // 主列：文字 + 動作鈕
        mainRow = new LinearLayout(ctx);
        mainRow.setOrientation(LinearLayout.HORIZONTAL);
        mainRow.setGravity(Gravity.CENTER_VERTICAL);

        textCol = new LinearLayout(ctx);
        textCol.setOrientation(LinearLayout.VERTICAL);

        titleText = new TextView(ctx);
        titleText.setTextColor(Color.WHITE);
        titleText.setTextSize(16);

        subText = new TextView(ctx);
        subText.setTextColor(Color.parseColor("#9AA0A6"));
        subText.setTextSize(12);

        textCol.addView(titleText);
        textCol.addView(subText);

        actionBtn = new Button(ctx);
        actionBtn.setTextColor(Color.WHITE);
        actionBtn.setTextSize(15);
        actionBtn.setAllCaps(false);
        actionBtn.setGravity(Gravity.CENTER);
        actionBtn.setPadding(dp(20), dp(8), dp(20), dp(8));
        LinearLayout.LayoutParams aLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        aLp.leftMargin = dp(12);
        actionBtn.setLayoutParams(aLp);
        actionBtn.setOnClickListener(v -> {
            if ("idle".equals(mode)) notifyListeners("floatCommand", action("start"));
            else notifyListeners("floatCommand", action("end"));
        });

        mainRow.addView(textCol);
        mainRow.addView(actionBtn);

        // 車資鍵盤（預設隱藏）
        keypad = buildKeypad(ctx);
        keypad.setVisibility(View.GONE);

        card.addView(mainRow);
        card.addView(keypad);
        root.addView(card);

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        lp = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            android.graphics.PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dp(12);
        lp.y = dp(80);

        root.bind(wm, lp);
        wm.addView(root, lp);
    }

    private LinearLayout buildKeypad(Context ctx) {
        LinearLayout pad = new LinearLayout(ctx);
        pad.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams padLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        padLp.topMargin = dp(8);
        pad.setLayoutParams(padLp);

        fareDisplay = new TextView(ctx);
        fareDisplay.setTextColor(Color.WHITE);
        fareDisplay.setTextSize(22);
        fareDisplay.setGravity(Gravity.CENTER);
        fareDisplay.setPadding(0, dp(4), 0, dp(8));
        pad.addView(fareDisplay);

        String[][] rows = {
            {"1", "2", "3"},
            {"4", "5", "6"},
            {"7", "8", "9"},
            {"略過", "0", "⌫"}
        };
        for (String[] row : rows) {
            LinearLayout r = new LinearLayout(ctx);
            r.setOrientation(LinearLayout.HORIZONTAL);
            for (String key : row) r.addView(keyButton(ctx, key));
            pad.addView(r);
        }

        Button ok = new Button(ctx);
        ok.setText("確定");
        ok.setTextColor(Color.WHITE);
        ok.setAllCaps(false);
        GradientDrawable okBg = new GradientDrawable();
        okBg.setColor(Color.parseColor("#1A73E8"));
        okBg.setCornerRadius(dp(10));
        ok.setBackground(okBg);
        LinearLayout.LayoutParams okLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(44));
        okLp.topMargin = dp(6);
        ok.setLayoutParams(okLp);
        ok.setOnClickListener(v -> confirmFare());
        pad.addView(ok);

        return pad;
    }

    private Button keyButton(Context ctx, String key) {
        Button b = new Button(ctx);
        b.setText(key);
        b.setTextColor(Color.WHITE);
        b.setTextSize(18);
        b.setAllCaps(false);
        b.setGravity(Gravity.CENTER);
        b.setPadding(0, 0, 0, 0);
        GradientDrawable kb = new GradientDrawable();
        kb.setColor(Color.parseColor("#3C4043"));
        kb.setCornerRadius(dp(8));
        b.setBackground(kb);
        LinearLayout.LayoutParams lpb = new LinearLayout.LayoutParams(0, dp(48), 1f);
        lpb.setMargins(dp(3), dp(3), dp(3), dp(3));
        b.setLayoutParams(lpb);
        b.setOnClickListener(v -> onKey(key));
        return b;
    }

    private void onKey(String key) {
        switch (key) {
            case "略過":
                fareStr = "";
                confirmFare();
                return;
            case "⌫":
                if (fareStr.length() > 0) fareStr = fareStr.substring(0, fareStr.length() - 1);
                break;
            default: // 數字
                if (fareStr.length() < 6) fareStr += key;
                break;
        }
        updateFareDisplay();
    }

    private void confirmFare() {
        int value = fareStr.isEmpty() ? 0 : Integer.parseInt(fareStr);
        JSObject o = new JSObject();
        o.put("value", value);
        notifyListeners("floatFare", o);
        setIdle();
    }

    private void updateFareDisplay() {
        fareDisplay.setText("NT$ " + (fareStr.isEmpty() ? "0" : fareStr));
    }

    private void setIdle() {
        mode = "idle";
        keypad.setVisibility(View.GONE);
        mainRow.setVisibility(View.VISIBLE);
        textCol.setVisibility(View.GONE);   // 閒置只留 Start 按鈕，左邊文字隱藏
        actionBtn.setText("Start");
        setBtnColor(actionBtn, "#34A853");
    }

    private void setRecording(int elapsed, int distance) {
        mode = "recording";
        keypad.setVisibility(View.GONE);
        mainRow.setVisibility(View.VISIBLE);
        textCol.setVisibility(View.VISIBLE); // 記錄中才顯示時間 / 距離
        setText(elapsed, distance);
        actionBtn.setText("End");
        setBtnColor(actionBtn, "#EA4335");
    }

    private void showKeypad() {
        fareStr = "";
        updateFareDisplay();
        mainRow.setVisibility(View.GONE);
        keypad.setVisibility(View.VISIBLE);
    }

    private void setText(int elapsedSec, int distanceM) {
        int m = elapsedSec / 60, s = elapsedSec % 60;
        titleText.setText(String.format("%02d:%02d", m, s));
        if (distanceM >= 1000) subText.setText(String.format("%.1f 公里", distanceM / 1000.0));
        else subText.setText(distanceM + " 公尺");
    }

    private void setBtnColor(Button b, String hex) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(hex));
        d.setCornerRadius(dp(10));
        b.setBackground(d);
    }

    private void removeView() {
        if (wm != null && root != null) {
            try { wm.removeView(root); } catch (Exception ignored) {}
        }
        root = null;
    }

    private JSObject action(String a) {
        JSObject o = new JSObject();
        o.put("action", a);
        return o;
    }

    /** 整張卡片可任意拖曳；移動超過 touchSlop 才攔截，否則放行給按鈕點擊。 */
    public static class DragLayout extends FrameLayout {
        private WindowManager wm;
        private WindowManager.LayoutParams lp;
        private float downX, downY;
        private int startX, startY;
        private boolean dragging;
        private final int slop;

        public DragLayout(Context c) {
            super(c);
            slop = ViewConfiguration.get(c).getScaledTouchSlop();
        }

        void bind(WindowManager wm, WindowManager.LayoutParams lp) {
            this.wm = wm;
            this.lp = lp;
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent ev) {
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = ev.getRawX();
                    downY = ev.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    dragging = false;
                    return false;
                case MotionEvent.ACTION_MOVE:
                    if (!dragging &&
                        (Math.abs(ev.getRawX() - downX) > slop ||
                         Math.abs(ev.getRawY() - downY) > slop)) {
                        dragging = true;
                        return true;
                    }
                    return dragging;
            }
            return false;
        }

        @Override
        public boolean onTouchEvent(MotionEvent ev) {
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    if (dragging && wm != null) {
                        lp.x = startX + (int) (ev.getRawX() - downX);
                        lp.y = startY + (int) (ev.getRawY() - downY);
                        wm.updateViewLayout(this, lp);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    dragging = false;
                    return true;
            }
            return super.onTouchEvent(ev);
        }
    }
}
