# SPDX-License-Identifier: GPL-3.0-or-later
"""Non-destructive export frames. Photo samples remain float32; PIL draws masks only."""
from pathlib import Path
from datetime import datetime
from functools import lru_cache
import json, math, re
import numpy as np
from PIL import Image, ImageDraw, ImageFont

STYLES = {
    'none': ('无片边', '#f5f2eb', '#373d37', '#ad8255'),
    'film35': ('经典 35mm', '#141712', '#c9a36b', '#c9a36b'),
    'negative': ('暖棕负片', '#542e1e', '#deb784', '#deb784'),
    'film_bw': ('黑白 35mm', '#181a18', '#d1cdc0', '#d1cdc0'),
    'medium120': ('120 中画幅', '#171b18', '#cbb48b', '#cbb48b'),
    'scan': ('实扫毛边', '#151b17', '#d4c69e', '#d4c69e'),
    'slide': ('幻灯片框', '#e6e0d0', '#4c4e44', '#9b794c'),
    'instant': ('即影即有', '#f1ece1', '#4d5049', '#9b794c'),
    'gallery': ('画廊留白', '#faf8f2', '#333c36', '#9c8660'),
    'postcard': ('旅行明信片', '#e6dfcf', '#484e43', '#907a51'),
    'cinema': ('宽幕黑边', '#101311', '#e4dfd1', '#c5a675'),
    'archive': ('档案卡片', '#e9e5d9', '#3f4c42', '#8e744c'),
}
DEFAULTS = dict(style='none',width=.065,text_scale=1,font='mono',background='',ink='',accent='',
    date_mode='auto',date_text='',roll_name='',signature='',info_mode='auto',info_text='',frame_number='',
    show_roll=True,show_camera=True,show_lens=False,show_exposure=True,edge_code=True)

# Bitmap edge lettering adapted from NegativeConverter (MIT, Copyright 2025 lex).
EDGE_FONT = {'0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
 '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
 '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
 '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
 '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
 '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
 '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
 '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
 '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
 '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
 'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
 'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
 'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
 'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
 'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
 'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
 'G': ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
 'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
 'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
 'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
 'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
 'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
 'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
 'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
 'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
 'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
 'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
 'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
 'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
 'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
 'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
 'V': ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],
 'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
 'X': ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
 'Y': ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
 'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
 '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
 '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
 '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
 ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
 ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
 '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100']}

def validate(value=None):
    if isinstance(value,str):
        if len(value)>8192:raise ValueError('片边设置过长')
        try:value=json.loads(value) if value else {}
        except (ValueError,TypeError) as exc:raise ValueError('片边设置格式无效') from exc
    if value is None:value={}
    if not isinstance(value,dict):raise ValueError('片边设置必须为对象')
    result={**DEFAULTS,**{k:v for k,v in value.items() if k in DEFAULTS}}
    for key,choices in [('style',STYLES),('font',{'mono','sans','serif'}),('date_mode',{'auto','custom','none'}),('info_mode',{'auto','custom','none'})]:
        if not isinstance(result[key],str) or result[key] not in choices:raise ValueError('未知片边选项：'+key)
    for key,low,high in [('width',.025,.18),('text_scale',.6,1.6)]:
        v=result[key]
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not low<=v<=high:raise ValueError('片边参数越界：'+key)
    for key in ('background','ink','accent'):
        if not isinstance(result[key],str) or (result[key] and not re.fullmatch(r'#[0-9a-fA-F]{6}',result[key])):raise ValueError('片边颜色无效')
    for key,limit in [('date_text',60),('roll_name',120),('signature',120),('info_text',240),('frame_number',24)]:
        v=result[key]
        if not isinstance(v,str) or len(v)>limit or any(ord(c)<32 for c in v):raise ValueError('片边文字过长或含控制字符：'+key)
    for key in ('show_roll','show_camera','show_lens','show_exposure','edge_code'):
        if type(result[key]) is not bool:raise ValueError('片边开关无效：'+key)
    return result

def photo_info(photo):
    """Read only useful EXIF, never GPS. Unsupported metadata is simply omitted."""
    tags={}
    try:
        with Image.open(photo['path']) as source:
            root=source.getexif();tags.update(dict(root))
            if 34665 in root:tags.update(root.get_ifd(34665))
    except (OSError,ValueError,TypeError,KeyError):
        try:
            import tifffile
            with tifffile.TiffFile(photo['path']) as source:
                page=source.pages[0]
                tags.update({tag.code:tag.value for tag in page.tags.values()})
                detail=page.tags.get('ExifTag')
                if detail and isinstance(detail.value,dict):
                    mapping={'ExposureTime':33434,'FNumber':33437,'ISOSpeedRatings':34855,'PhotographicSensitivity':34855,'FocalLength':37386,'LensModel':42036,'DateTimeOriginal':36867}
                    tags.update({code:detail.value[name] for name,code in mapping.items() if name in detail.value})
        except Exception:pass
    def clean(v):return str(v).replace('\x00','').strip()[:160] if v is not None else ''
    def numeric(v):
        try:
            if isinstance(v,(list,tuple)):v=v[0]/v[1] if len(v)==2 else v[0]
            n=float(v);return n if math.isfinite(n) and n>0 else None
        except (TypeError,ValueError,ZeroDivisionError):return None
    date=''
    value=tags.get(36867) or tags.get(306)
    try:date=datetime.strptime(str(value)[:19],'%Y:%m:%d %H:%M:%S').strftime('%Y.%m.%d')
    except (TypeError,ValueError):
        if photo.get('captured'):
            try:date=datetime.fromtimestamp(float(photo['captured'])).strftime('%Y.%m.%d')
            except (ValueError,OverflowError,OSError):pass
    focal=numeric(tags.get(37386));aperture=numeric(tags.get(33437));shutter=numeric(tags.get(33434));iso=numeric(tags.get(34855))
    exposure=[]
    if focal:exposure.append(f'{focal:g}mm')
    if aperture:exposure.append(f'f/{aperture:g}')
    if shutter:exposure.append(f'1/{round(1/shutter)}s' if shutter<1 else f'{shutter:g}s')
    if iso:exposure.append(f'ISO {iso:g}')
    return dict(date=date,date_source='exif' if value else photo.get('time_source','file'),
        camera=' '.join(dict.fromkeys(filter(None,[clean(tags.get(271)),clean(tags.get(272))]))),
        lens=clean(tags.get(42036)),exposure=' · '.join(exposure),roll_name=photo.get('border_album',''),frame=str(photo.get('id',1)).zfill(2))

def labels(config,info):
    c=validate(config)
    technical=''
    if c['info_mode']=='custom':
        technical=c['info_text']
    elif c['info_mode']=='auto':
        technical=' · '.join(filter(None,[
            info.get('camera','') if c['show_camera'] else '',
            info.get('lens','') if c['show_lens'] else '',
            info.get('exposure','') if c['show_exposure'] else '',
        ]))
    return dict(roll=(c['roll_name'] or info.get('roll_name','') or 'PHOTO ALL') if c['show_roll'] else '',
        date=c['date_text'] if c['date_mode']=='custom' else info.get('date','') if c['date_mode']=='auto' else '',
        signature=c['signature'],technical=technical,frame=c['frame_number'] or info.get('frame','01'))

@lru_cache(maxsize=96)
def font(kind,size,cjk=False):
    windows=Path('C:/Windows/Fonts')
    names=(['simsun.ttc'] if kind=='serif' else ['msyh.ttc']) if cjk else {'mono':['consola.ttf','cour.ttf'],'sans':['segoeui.ttf','arial.ttf'],'serif':['georgia.ttf','times.ttf']}[kind]
    for candidate in [*(windows/name for name in names),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]:
        if candidate.exists():
            try:return ImageFont.truetype(str(candidate),size)
            except OSError:pass
    return ImageFont.load_default(size=size)

def rgb(value):return np.array([int(value[i:i+2],16)/255 for i in (1,3,5)],dtype=np.float32)

def film_metrics(width,height):
    # 135 frame gate: 24mm high on a 34.98mm strip. KS axes verified against
    # Kodak Essential Reference Guide, p.96 (PDF p.98); do not stretch holes.
    mm=height/24
    return dict(px_mm=mm,band=round((34.98-24)/2*mm),side=max(1,round(mm)),
        pitch=4.75*mm,hole_width=2.794*mm,hole_height=1.981*mm,radius=.51*mm)

def dx_blocks(frame):
    """NegativeConverter MIT adaptation: frame-number illustration, stock fields unknown."""
    frame=max(0,min(63,frame));blocks=set()
    for col in range(5):blocks.add((col,0))
    for col in range(0,5,2):blocks.add((col,1))
    for col in range(6,31,2):blocks.add((col,0))
    for bit in range(6):
        if frame & (32>>bit):blocks.add((18+bit,1))
    flag=int(frame>36)
    if flag:blocks.add((24,1))
    if (frame.bit_count()+flag)%2:blocks.add((26,1))
    blocks.update({(29,0),(28,1),(30,1)})
    return sorted(blocks)

@lru_cache(maxsize=1)
def scan_alpha():
    asset=Path(__file__).parent/'engines/film-borders/scan-border.png'
    with Image.open(asset) as image:return image.getchannel('A').copy()

def scan_rebate(output,image,x,y,w,h,color):
    # Retain the original scanned contour. Extend only the source's outermost
    # samples into the rebate; never cover or quantize any original photo pixel.
    alpha=scan_alpha();depth=max(2,round(min(w,h)*.012))
    pieces=[(alpha.crop((0,0,alpha.width,38)),(w,depth),(x,y-depth),np.repeat(image[0:1,:,:3],depth,axis=0)),
        (alpha.crop((0,alpha.height-38,alpha.width,alpha.height)),(w,depth),(x,y+h),np.repeat(image[-1:,:,:3],depth,axis=0)),
        (alpha.crop((0,0,38,alpha.height)),(depth,h),(x-depth,y),np.repeat(image[:,0:1,:3],depth,axis=1)),
        (alpha.crop((alpha.width-38,0,alpha.width,alpha.height)),(depth,h),(x+w,y),np.repeat(image[:,-1:,:3],depth,axis=1))]
    for mask,size,(px,py),extension in pieces:
        values=np.asarray(mask.resize(size,Image.Resampling.LANCZOS),dtype=np.float32)[...,None]/255
        output[py:py+size[1],px:px+size[0]]=extension*(1-values)+color*values

def compose(image,config=None,info=None,max_size=0):
    """Return float pixels and the unchanged photo rectangle in final coordinates."""
    c=validate(config);info=info or {};style=c['style'];image=np.asarray(image,dtype=np.float32)
    if style=='none':return image,{'image':[0,0,image.shape[1],image.shape[0]],'width':image.shape[1],'height':image.shape[0]}
    real_film=style in {'film35','negative','film_bw'}
    rotated=(real_film or style=='medium120') and image.shape[0]>image.shape[1]
    if rotated:image=np.rot90(image)
    h,w=image.shape[:2];unit=max(10,round(max(w,h)*c['width']))
    fs=max(8,round(unit*.29*c['text_scale']));line=round(fs*1.65)
    side=unit;top=unit;bottom=unit+line*2
    if real_film:
        metrics=film_metrics(w,h);side=metrics['side'];top=bottom=max(6,metrics['band'])
        fs=max(7,round(metrics['px_mm']*.85*c['text_scale']));line=round(fs*1.3)
    elif style=='medium120':
        mm=h/56;side=max(2,round(mm*3));top=bottom=max(10,round(mm*2.5));fs=max(7,round(mm*1.05*c['text_scale']));line=fs
    elif style=='slide':side=round(unit*1.6);top=unit+line;bottom=unit+line*2
    elif style=='instant':top=side=round(unit*.75);bottom=unit*3+line
    elif style=='cinema':side=max(4,round(unit*.35));top=unit*2;bottom=unit*2+line
    elif style=='archive':top=unit+line;bottom=unit+line*3
    total_w=w+side*2;total_h=h+top+bottom
    if style=='slide':
        total_w=total_h=max(total_w,total_h)
        side=(total_w-w)//2;top=(total_h-h)//2;bottom=total_h-h-top
    if max_size and max(total_w,total_h)>max_size:
        import pixels
        scale=max_size/max(total_w,total_h)
        resized=pixels.resize(image,(max(1,round(w*scale)),max(1,round(h*scale))))
        adjusted=dict(c)
        result,layout=compose(np.rot90(resized,-1) if rotated else resized,adjusted,info)
        if max(result.shape[:2])>max_size:
            ratio=max_size/max(result.shape[:2]);new_w=max(1,round(result.shape[1]*ratio));new_h=max(1,round(result.shape[0]*ratio))
            result=pixels.resize(result,(new_w,new_h));layout={'image':[round(v*ratio) for v in layout['image']],'width':new_w,'height':new_h}
        return result,layout
    paper=rgb(c['background'] or STYLES[style][1]);ink=rgb(c['ink'] or STYLES[style][2]);accent=rgb(c['accent'] or STYLES[style][3])
    output=np.empty((total_h,total_w,3),np.float32);output[:]=paper
    if image.shape[-1]==4:output[top:top+h,side:side+w]=image[...,:3]*image[...,3:]+paper*(1-image[...,3:])
    else:output[top:top+h,side:side+w]=image
    if style=='scan':scan_rebate(output,image,side,top,w,h,paper)
    words=labels(c,info)
    def text(value,x,y,width,color=ink,align='left',scale=1):
        if not value or width<3:return
        if real_film and c['font']=='mono' and all(char.upper() in EDGE_FONT for char in str(value)):
            value=str(value).upper();height=max(7,round(fs*scale));ratio=height/7
            value=value[:max(0,int(width/(6*ratio)))]
            if not value:return
            mask=Image.new('L',(len(value)*6,7));draw=ImageDraw.Draw(mask)
            for index,char in enumerate(value):
                for gy,row in enumerate(EDGE_FONT[char]):
                    for gx,bit in enumerate(row):
                        if bit=='1':draw.point((index*6+gx,gy),fill=255)
            mw=max(1,round(mask.width*ratio));mask=mask.resize((mw,height),Image.Resampling.NEAREST)
            x=int(x+(width-mw if align=='right' else (width-mw)/2 if align=='center' else 0));y=int(y)
            x=max(0,min(total_w-mw,x));y=max(0,min(total_h-height,y))
            if x<side+w and x+mw>side and y<top+h and y+height>top:return
            alpha=np.asarray(mask,dtype=np.float32)[...,None]/255;area=output[y:y+height,x:x+mw];area[:]=area*(1-alpha)+color*alpha
            return
        value=str(value);face=font(c['font'],max(7,round(fs*scale)),any(ord(v)>127 for v in value))
        while value and face.getlength(value)>width:
            value=value[:-2]+'…' if len(value)>2 else ''
        if not value:return
        l,t,r,b=face.getbbox(value);mw=max(1,math.ceil(face.getlength(value))+2);mh=max(1,b-t+3)
        mask=Image.new('L',(mw,mh));ImageDraw.Draw(mask).text((-l,1-t),value,font=face,fill=255)
        x=int(x+(width-mw if align=='right' else (width-mw)/2 if align=='center' else 0));y=int(y)
        x=max(0,min(total_w-mw,x));y=max(0,min(total_h-mh,y))
        if x<side+w and x+mw>side and y<top+h and y+mh>top:return
        alpha=np.asarray(mask,dtype=np.float32)[...,None]/255
        area=output[y:y+mh,x:x+mw];area[:]=area*(1-alpha)+color*alpha
    if real_film:
        mm=metrics['px_mm'];pitch=max(1,metrics['pitch'])
        # Only the rebate receives a restrained emulsion texture.
        for region in [output[:top],output[top+h:],output[top:top+h,:side],output[top:top+h,side+w:]]:
            for row in range(0,region.shape[0],128):
                slab=region[row:row+128]
                yy=np.arange(row,row+slab.shape[0],dtype=np.float32)[:,None]
                xx=np.arange(slab.shape[1],dtype=np.float32)[None,:]
                noise=np.mod(np.sin(xx*12.9898+yy*78.233+3508)*43758.5453,1)-.5
                slab[:]=np.clip(slab+noise[...,None]*.0025,0,1)
        hw=max(2,round(metrics['hole_width']));hh=max(2,round(metrics['hole_height']))
        hole=Image.new('L',(hw*4,hh*4));ImageDraw.Draw(hole).rounded_rectangle((0,0,hw*4-1,hh*4-1),radius=metrics['radius']*4,fill=255)
        hole=hole.resize((hw,hh),Image.Resampling.LANCZOS)
        hole_values=np.asarray(hole,dtype=np.float32)[...,None]/255
        for edge in [round(mm*2),total_h-round(mm*2)-hh]:
            for index in range(-1,math.ceil(total_w/pitch)+1):
                left=round(side+pitch*(index+.5)-hw/2);lo=max(0,left);hi=min(total_w,left+hw)
                if hi<=lo:continue
                alpha=hole_values[:,lo-left:hi-left]
                area=output[edge:edge+hh,lo:hi];area[:]=area*(1-alpha)+rgb('#f0eee5')*alpha
        text(words['roll'],side,max(1,round(mm*.12)),w*.72,accent,scale=.9)
        text(words['date'],side+w*.73,max(1,round(mm*.12)),w*.27,accent,'right',.85)
        text(words['technical'],side,top-max(8,round(mm*1.3)),w,accent,scale=.75)
        text(words['frame']+'A  >',side,total_h-max(8,round(mm*1.5)),w*.19,accent,scale=.95)
        text(words['signature'],side+w*.66,total_h-max(8,round(mm*1.5)),w*.34,accent,'right',.85)
        if c['edge_code']:
            digits=re.search(r'\d+',words['frame']);number=int(digits.group()) if digits else 0
            module=13*mm/31;x0=side+w*.24;y0=total_h-max(2,round(mm*1.7));bh=max(1,round(mm*.65))
            for col,row in dx_blocks(number):
                x1=round(x0+col*module);x2=round(x0+(col+1)*module)
                output[y0+row*bh:y0+(row+1)*bh,x1:x2]=accent
    elif style=='medium120':
        text(words['roll'],side,1,w*.8,accent,scale=.9)
        text(words['frame'],side+w*.82,1,w*.18,accent,'right',.9)
        text(' · '.join(filter(None,[words['technical'],words['signature'],words['date']])),side,top+h+1,w,accent,scale=.85)
    else:
        if style=='archive':text(' / '.join(filter(None,[words['roll'],words['frame']])),side,max(2,round(unit*.25)),w,ink)
        caption_y=top+h+max(5,round(unit*.35))
        text(words['roll'],side,caption_y,w*.65,ink,scale=1.12)
        text(words['date'],side+w*.67,caption_y,w*.33,accent,'right')
        text(words['technical'],side,caption_y+line,w*.76,ink)
        text(words['signature'],side+w*.55,caption_y+line*2,w*.45,accent,'right',1.15)
        if style in {'gallery','postcard','archive'}:
            y=top+h+max(2,round(unit*.13));output[y:y+max(1,round(unit*.015)),side:side+w]=accent
    rect=[side,top,w,h]
    if rotated:
        output=np.rot90(output,-1);rect=[total_h-(top+h),side,h,w]
    return output,{'image':rect,'width':output.shape[1],'height':output.shape[0]}
