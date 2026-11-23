package com.example.radiance.prototype

import android.animation.ValueAnimator
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

class RadianceActivity : ComponentActivity() {
    private lateinit var surface: OrbSurface
    private lateinit var fallback: OrbFallback
    private val shell = ShellMotion()
    private var autoFlat by mutableStateOf(false)
    private var diagnostics by mutableStateOf("Preparing native renderer…")
    private var motionEnabled by mutableStateOf(true)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        surface=OrbSurface(this,{ diagnostics=it },{ autoFlat=true },shell)
        fallback=OrbFallback(this,shell)
        setContent {
            var mode by remember { mutableIntStateOf(1) }
            var reduced by remember { mutableStateOf(false) }
            var light by remember { mutableStateOf(true) }
            var animatePreview by remember { mutableStateOf(false) }
            var quality by remember { mutableIntStateOf(0) }
            val flat=quality==2 || (quality==0 && autoFlat)
            val ink=Color(0xfff4eee4)
            val muted=Color(0xffc5bfcc)
            val sceneMode=mode
            val sceneStill=reduced || (!motionEnabled && !animatePreview)
            val sceneLight=light
            SideEffect {
                shell.target(sceneMode,sceneStill)
                surface.update(sceneMode,sceneStill,sceneLight,!flat,quality==0)
                fallback.update(!sceneStill && flat,sceneLight,sceneMode)
            }
            MaterialTheme(colorScheme=darkColorScheme()) {
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory={surface},modifier=Modifier.fillMaxSize())
                    if(flat) AndroidView(factory={fallback},modifier=Modifier.fillMaxSize())
                    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal=24.dp)) {
                        Row(Modifier.fillMaxWidth().padding(top=18.dp),verticalAlignment=Alignment.CenterVertically) {
                            Text("away",color=ink,fontSize=26.sp,fontWeight=FontWeight.Medium)
                            Spacer(Modifier.weight(1f))
                            Text("R A D I A N C E",color=muted,fontSize=11.sp)
                        }
                        Text("SPECTRAL LENS · MOTION STUDY",color=muted,fontSize=10.sp,modifier=Modifier.padding(top=10.dp))
                        Spacer(Modifier.weight(1f))
                        Column(Modifier.fillMaxWidth().heightIn(max=350.dp).verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally) {
                            Text(listOf("Gathering light","Listening","Speaking","A moment of stillness","Disconnected")[mode],color=ink,fontSize=30.sp,fontWeight=FontWeight.Light)
                            Text(if(mode==2)"“A simpler approach leaves room to grow.”" else if(mode==1)"“Let’s make something extraordinary.”" else "The light settles. Your place remains.",color=muted,fontSize=15.sp,modifier=Modifier.padding(top=12.dp,bottom=20.dp))
                            Row(Modifier.fillMaxWidth().background(Color(0xcc1c1c2b),RoundedCornerShape(26.dp)).padding(6.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
                                TextButton(onClick={mode=1}){Text("Listen",color=ink)}
                                TextButton(onClick={mode=2}){Text("Speak",color=ink)}
                                TextButton(onClick={mode=4}){Text("End",color=Color(0xffe9898f))}
                            }
                            Row(horizontalArrangement=Arrangement.Center) {
                                TextButton(onClick={mode=0}){Text("Connect",color=muted)}
                                TextButton(onClick={mode=3}){Text("Silence",color=muted)}
                                TextButton(onClick={light=!light}){Text(if(light)"Dark backdrop"else"Reference backdrop",color=muted)}
                            }
                            Row(verticalAlignment=Alignment.CenterVertically) {
                                Text("Reduced motion",color=muted,fontSize=13.sp)
                                Spacer(Modifier.width(12.dp))
                                Switch(checked=reduced,onCheckedChange={reduced=it})
                            }
                            if(!motionEnabled) {
                                TextButton(onClick={animatePreview=!animatePreview}) {
                                    Text(if(animatePreview)"Reference motion playing" else "Play reference motion (system motion is off)",color=ink)
                                }
                            }
                            Row {
                                TextButton(onClick={quality=0;autoFlat=false}){Text("Auto",color=if(quality==0)ink else muted)}
                                TextButton(onClick={quality=1}){Text("GPU",color=if(quality==1)ink else muted)}
                                TextButton(onClick={quality=2}){Text("2D",color=if(quality==2)ink else muted)}
                            }
                            Text("Synthetic reference timing · no microphone or connection",color=muted,fontSize=10.sp)
                            Text(if(flat)"Lightweight 2D · ${if(quality==0) "measured fallback" else "manual"}" else diagnostics,color=muted,fontSize=10.sp,modifier=Modifier.padding(top=4.dp,bottom=12.dp))
                        }
                    }
                }
            }
        }
    }
    override fun onResume(){super.onResume();motionEnabled=ValueAnimator.areAnimatorsEnabled();if(::surface.isInitialized)surface.resume();if(::fallback.isInitialized)fallback.resume()}
    override fun onPause(){if(::surface.isInitialized)surface.pause();if(::fallback.isInitialized)fallback.pause();super.onPause()}
    override fun onDestroy(){if(::surface.isInitialized)surface.dispose();super.onDestroy()}
}
