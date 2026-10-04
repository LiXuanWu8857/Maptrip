package com.maptrip.app;

import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
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
import android.widget.ImageView;
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
    private ImageView appIcon;
    private LinearLayout textCol;
    private TextView titleText;
    private TextView subText;
    private Button actionBtn;
    private LinearLayout keypad;
    private TextView fareDisplay;
    private TextView dispatchToggle;   // 叫車費切換（跟 iPhone 車資對話框一樣）

    private String mode = "idle";     // "idle" | "recording"
    private String fareStr = "";
    private static final int DISPATCH_FEE = 10;   // 叫車費固定 10 元
    private boolean dispatchOn = true;            // 預設「有」叫車費（每次開鍵盤重設）

    // ---- App 風格配色（比照 css/style.css 車資對話框；系統深色自適應）----
    // night 於 buildView 建立浮層時擷取當下系統主題（沿用整個浮層生命週期）。
    private boolean night = false;
    private boolean isNight() {
        try {
            int m = getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return m == Configuration.UI_MODE_NIGHT_YES;
        } catch (Exception e) { return false; }
    }
    // 依主題選色：淺色 / 深色
    private int col(String light, String dark) { return Color.parseColor(night ? dark : light); }

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
        night = isNight();   // 擷取當下系統主題
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

        root = new DragLayout(ctx);

        LinearLayout card = new LinearLayout(ctx);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(col("#FFFFFF", "#1E1E1E"));     // App 風格：白卡／深色卡
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(1), col("#E0E2E6", "#333333"));
        card.setBackground(bg);

        // 主列：文字 + 動作鈕
        mainRow = new LinearLayout(ctx);
        mainRow.setOrientation(LinearLayout.HORIZONTAL);
        mainRow.setGravity(Gravity.CENTER_VERTICAL);
        mainRow.setLayoutParams(new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        // App 圖示（取代原本的 🚗 emoji）
        appIcon = new ImageView(ctx);
        appIcon.setImageResource(R.mipmap.ic_launcher);
        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(42), dp(42));
        iconLp.rightMargin = dp(12);   // logo 與按鈕中間間隔 = 卡片左右內距
        appIcon.setLayoutParams(iconLp);

        textCol = new LinearLayout(ctx);
        textCol.setOrientation(LinearLayout.VERTICAL);

        titleText = new TextView(ctx);
        titleText.setTextColor(col("#202124", "#E8EAED"));
        titleText.setTextSize(16);

        subText = new TextView(ctx);
        subText.setTextColor(col("#5F6368", "#9AA0A6"));
        subText.setTextSize(12);

        textCol.addView(titleText);
        textCol.addView(subText);

        actionBtn = new Button(ctx);
        actionBtn.setTextColor(Color.WHITE);
        actionBtn.setTextSize(13);
        actionBtn.setAllCaps(false);
        actionBtn.setGravity(Gravity.CENTER);
        actionBtn.setPadding(dp(10), dp(5), dp(10), dp(5));
        actionBtn.setMinWidth(0);
        actionBtn.setMinimumWidth(0);
        actionBtn.setMinHeight(0);
        actionBtn.setMinimumHeight(0);
        LinearLayout.LayoutParams aLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        aLp.leftMargin = dp(12);
        actionBtn.setLayoutParams(aLp);
        actionBtn.setOnClickListener(v -> {
            if ("idle".equals(mode)) notifyListeners("floatCommand", action("start"));
            else notifyListeners("floatCommand", action("end"));
        });

        mainRow.addView(appIcon);
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
            dp(240),
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
        fareDisplay.setTextColor(col("#202124", "#E8EAED"));
        fareDisplay.setTextSize(24);
        fareDisplay.setGravity(Gravity.CENTER);
        fareDisplay.setPadding(0, dp(2), 0, dp(10));
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
            r.setBaselineAligned(false);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            r.setLayoutParams(rowLp);
            for (String key : row) r.addView(keyButton(ctx, key));
            pad.addView(r);
        }

        // 叫車費切換（整排一顆，跟 iPhone 一樣：預設「有 $10」，點一下切「無」）
        dispatchToggle = new TextView(ctx);
        dispatchToggle.setGravity(Gravity.CENTER);
        dispatchToggle.setTextSize(15);
        LinearLayout.LayoutParams dispLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(46));
        dispLp.topMargin = dp(10);
        dispatchToggle.setLayoutParams(dispLp);
        dispatchToggle.setClickable(true);
        dispatchToggle.setOnClickListener(v -> { dispatchOn = !dispatchOn; updateDispatchToggle(); });
        pad.addView(dispatchToggle);
        updateDispatchToggle();

        LinearLayout payRow = new LinearLayout(ctx);
        payRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams payRowLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(50));
        payRowLp.topMargin = dp(10);
        payRow.setLayoutParams(payRowLp);

        TextView cashBtn = payButton(ctx, "現金", "#34A853");
        LinearLayout.LayoutParams cashLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        cashLp.rightMargin = dp(4);
        cashBtn.setLayoutParams(cashLp);
        cashBtn.setOnClickListener(v -> confirmFare("cash"));

        TextView cardBtn = payButton(ctx, "刷卡", "#1A73E8");
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        cardLp.leftMargin = dp(4);
        cardBtn.setLayoutParams(cardLp);
        cardBtn.setOnClickListener(v -> confirmFare("card"));

        payRow.addView(cashBtn);
        payRow.addView(cardBtn);
        pad.addView(payRow);

        return pad;
    }

    // 用 TextView 取代 Button：沒有預設的 minWidth / 內距 / 陰影，
    // 等寬權重的格子才能像素級對齊（Button 預設樣式會把按鍵撐歪）。
    private TextView keyButton(Context ctx, String key) {
        boolean muted = "略過".equals(key) || "⌫".equals(key);   // 功能鍵：淡色小字
        TextView b = new TextView(ctx);
        b.setText(key);
        b.setTextColor(muted ? col("#5F6368", "#9AA0A6") : col("#202124", "#E8EAED"));
        b.setTextSize(muted ? 16 : 19);
        b.setGravity(Gravity.CENTER);
        b.setPadding(0, 0, 0, 0);
        GradientDrawable kb = new GradientDrawable();
        kb.setColor(col("#F1F3F4", "#2A2A2A"));      // App 風格：淺灰鍵
        kb.setCornerRadius(dp(12));
        b.setBackground(kb);
        LinearLayout.LayoutParams lpb = new LinearLayout.LayoutParams(0, dp(50), 1f);
        lpb.setMargins(dp(4), dp(4), dp(4), dp(4));
        b.setLayoutParams(lpb);
        b.setClickable(true);
        b.setOnClickListener(v -> onKey(key));
        return b;
    }

    // 現金 / 刷卡 大鈕（同樣用 TextView 避免 Button 預設樣式）
    private TextView payButton(Context ctx, String label, String hex) {
        TextView b = new TextView(ctx);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setTextSize(16);
        b.setGravity(Gravity.CENTER);
        b.setPadding(0, 0, 0, 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(hex));
        bg.setCornerRadius(dp(12));
        b.setBackground(bg);
        b.setClickable(true);
        return b;
    }

    private void onKey(String key) {
        switch (key) {
            case "略過":
                fareStr = "";
                confirmFare("");
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

    // 叫車費切換（比照 App .fare-toggle）：開＝淺藍底＋藍字藍框、關＝淺灰底＋灰字
    private void updateDispatchToggle() {
        if (dispatchToggle == null) return;
        dispatchToggle.setText(dispatchOn ? ("叫車費 $" + DISPATCH_FEE) : "叫車費 無");
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        if (dispatchOn) {
            dispatchToggle.setTextColor(col("#1A73E8", "#8AB4F8"));
            bg.setColor(col("#E8F0FE", "#1E3A5F"));
            bg.setStroke(dp(1), col("#1A73E8", "#8AB4F8"));
        } else {
            dispatchToggle.setTextColor(col("#9AA0A6", "#7A7F87"));
            bg.setColor(col("#F1F3F4", "#2A2A2A"));
            bg.setStroke(dp(1), col("#E0E2E6", "#333333"));
        }
        dispatchToggle.setBackground(bg);
    }

    private void confirmFare(String paymentMethod) {
        int value = fareStr.isEmpty() ? 0 : Integer.parseInt(fareStr);
        JSObject o = new JSObject();
        o.put("value", value);
        o.put("paymentMethod", paymentMethod);
        o.put("dispatch", dispatchOn ? DISPATCH_FEE : 0);
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
        mainRow.setGravity(Gravity.CENTER_VERTICAL);
        // 左側：App 圖示（idle 不顯示文字欄）
        if (appIcon != null) appIcon.setVisibility(View.VISIBLE);
        textCol.setVisibility(View.GONE);
        // 右側：藍色按鈕橫向填滿、字置中、上下撐滿 logo 高
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
            0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        btnLp.leftMargin = 0;
        actionBtn.setLayoutParams(btnLp);
        actionBtn.setTextSize(12);
        actionBtn.setPadding(dp(10), 0, dp(10), 0);
        actionBtn.setText("▶ 開始行程");
        setBtnColor(actionBtn, "#1A73E8");
    }

    private void setRecording(int elapsed, int distance) {
        mode = "recording";
        keypad.setVisibility(View.GONE);
        mainRow.setVisibility(View.VISIBLE);
        mainRow.setGravity(Gravity.CENTER_VERTICAL);
        if (appIcon != null) appIcon.setVisibility(View.GONE);
        // 左側：時間/距離用自然寬度（不吃 weight），把剩餘空間留給右側按鈕
        textCol.setVisibility(View.VISIBLE);
        LinearLayout.LayoutParams textLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        textCol.setLayoutParams(textLp);
        subText.setVisibility(View.VISIBLE);
        titleText.setVisibility(View.VISIBLE);
        titleText.setTextSize(15);   // 時間字縮小
        subText.setTextSize(9);      // 公尺縮小 2pt
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subText.setLayoutParams(subLp);
        subText.setGravity(Gravity.CENTER_HORIZONTAL);  // 公尺置中於時間下方
        setText(elapsed, distance);
        // 右側：紅色「結束」橫向填滿、字置中、上下撐滿兩行文字高
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
            0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        btnLp.leftMargin = dp(12);
        actionBtn.setLayoutParams(btnLp);
        actionBtn.setTextSize(12);
        actionBtn.setPadding(dp(10), 0, dp(10), 0);
        actionBtn.setText("結束");
        setBtnColor(actionBtn, "#EA4335");
    }

    private void showKeypad() {
        fareStr = "";
        dispatchOn = true;          // 每次開鍵盤預設「有」叫車費（跟 iPhone 一樣）
        updateDispatchToggle();
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
        d.setCornerRadius(dp(12));
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

    /** 整張卡片可任意拖曳；移動超過 touchSlop 才攔截，否則放行給按鈕點擊。
     *  雙指捏合可縮放視窗寬度（150dp – 320dp）。 */
    public static class DragLayout extends FrameLayout {
        private WindowManager wm;
        private WindowManager.LayoutParams lp;
        private float downX, downY;
        private int startX, startY;
        private boolean dragging;
        private final int slop;

        private boolean pinching = false;
        private float initialSpan = 0;
        private int initialWinWidth = 0;

        public DragLayout(Context c) {
            super(c);
            slop = ViewConfiguration.get(c).getScaledTouchSlop();
        }

        void bind(WindowManager wm, WindowManager.LayoutParams lp) {
            this.wm = wm;
            this.lp = lp;
        }

        private float span(MotionEvent ev) {
            float dx = ev.getX(0) - ev.getX(1);
            float dy = ev.getY(0) - ev.getY(1);
            return (float) Math.sqrt(dx * dx + dy * dy);
        }

        private int dpx(float v) {
            return Math.round(v * getContext().getResources().getDisplayMetrics().density);
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
                    pinching = false;
                    return false;
                case MotionEvent.ACTION_POINTER_DOWN:
                    if (ev.getPointerCount() == 2) {
                        pinching = true;
                        dragging = false;
                        initialSpan = span(ev);
                        initialWinWidth = lp.width;
                        return true;
                    }
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (pinching) return true;
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
                    if (pinching && wm != null && ev.getPointerCount() >= 2) {
                        float scale = span(ev) / initialSpan;
                        int newW = Math.max(dpx(150), Math.min(dpx(320),
                            (int)(initialWinWidth * scale)));
                        lp.width = newW;
                        wm.updateViewLayout(this, lp);
                        return true;
                    }
                    if (dragging && wm != null) {
                        lp.x = startX + (int) (ev.getRawX() - downX);
                        lp.y = startY + (int) (ev.getRawY() - downY);
                        wm.updateViewLayout(this, lp);
                    }
                    return true;
                case MotionEvent.ACTION_POINTER_UP:
                    if (ev.getPointerCount() <= 2) pinching = false;
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    dragging = false;
                    pinching = false;
                    return true;
            }
            return super.onTouchEvent(ev);
        }
    }
}
